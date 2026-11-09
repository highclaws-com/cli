import fs from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { Command } from "commander"
import { USER_CACHE_DIR } from "../config"
import { run } from "../exec"
import { ensureProxyHelper } from "../proxy-helper"

// Reverse-forwards the sandbox's 127.0.0.1:2222 to this computer's sshd on
// port 22. The endpoint decodes to JSON with the sandbox's SSH client key
// ("key") and host key ("host_key").
async function safeExpose(endpoint: string): Promise<void> {
  const helper = await ensureProxyHelper(false)
  const helperPath = helper.split(path.sep).join("/")
  const quotedHelper = process.platform === "win32"
    ? `"${helperPath}"`
    : `'${helperPath.replace(/'/g, "'\\''")}'`
  const decoded = JSON.parse(Buffer.from(endpoint, "base64url").toString("utf8"))
  // Re-encode transport fields so ProxyCommand receives no shell syntax or SSH keys.
  endpoint = Buffer.from(JSON.stringify({
    server: decoded.server,
    destination: decoded.destination,
    uuid: decoded.uuid,
    pbk: decoded.pbk,
    sid: decoded.sid,
    sni: decoded.sni
  })).toString("base64url")
  const dir = path.join(USER_CACHE_DIR, "safe-expose")
  const keyFile = path.join(dir, "key")
  const knownHostsFile = path.join(dir, "known_hosts")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(keyFile, decoded.key, { mode: 0o600 })
  if (process.platform === "win32") {
    const code = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$acl = New-Object System.Security.AccessControl.FileSecurity",
        "$acl.SetOwner($user)",
        "$acl.SetAccessRuleProtection($true, $false)",
        "$acl.AddAccessRule(" +
          "[System.Security.AccessControl.FileSystemAccessRule]::new(" +
          "$user, 'FullControl', 'Allow'))",
        "Set-Acl -LiteralPath $env:SSH_KEY_FILE -AclObject $acl"
      ].join("; ")
    ], { env: { SSH_KEY_FILE: keyFile } })
    if (code !== 0) throw new Error("failed to set SSH key file permissions")
  } else {
    fs.chmodSync(keyFile, 0o600)
  }
  fs.writeFileSync(knownHostsFile, `sandbox ${decoded.host_key}\n`)

  const child = spawn("ssh", [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "LogLevel=VERBOSE",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "HostKeyAlias=sandbox",
    "-o", `UserKnownHostsFile="${knownHostsFile.split(path.sep).join("/")}"`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ProxyCommand=${quotedHelper.replace(/%/g, "%%")} ssh-tunnel ${endpoint}`,
    "-R", "127.0.0.1:2222:127.0.0.1:22",
    "-i", keyFile,
    "tunnel@sandbox"
  ], { stdio: ["inherit", "inherit", "pipe"] })
  child.stderr!.on("data", (chunk) => {
    process.stderr.write(chunk)
  })
  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
    child.kill("SIGINT")
  }
  process.on("SIGINT", onInterrupt)
  try {
    const [code, signal] = await once(child, "close")
    if (code !== 0 && !interrupted && signal !== "SIGINT") {
      throw new Error(`ssh exited with code ${code}`)
    }
  } finally {
    process.off("SIGINT", onInterrupt)
  }
}

export function registerSafeExpose(program: Command): void {
  program
    .command("safe-expose <endpoint>")
    .description("let the sandbox reach this computer's SSH server (port 22)")
    .action(safeExpose)
}
