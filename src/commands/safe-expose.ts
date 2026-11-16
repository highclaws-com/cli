import fs from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { Command } from "commander"
import { USER_CACHE_DIR, USER_CONFIG_PATH, getUserConfig, updateUserConfig } from "../config"
import { run } from "../exec"
import { askSecrets } from "../output"
import { ensureProxyHelper } from "../proxy-helper"

// Sandbox TCP port of the SSH server that accepts the reverse forward.
const REVERSE_SSH_PORT = 2022

// Base64url JSON of the endpoint's transport fields, addressed to sandbox
// TCP `port`: no SSH keys, e.g. destination "10.20.0.5" -> "10.20.0.5:2022".
export function tunnelValue(decoded: any, port: number): string {
  return Buffer.from(JSON.stringify({
    server: decoded.server,
    destination: `${decoded.destination}:${port}`,
    uuid: decoded.uuid,
    pbk: decoded.pbk,
    sid: decoded.sid,
    sni: decoded.sni
  })).toString("base64url")
}

// Reverse-forwards the sandbox's 127.0.0.1:<port> to this computer's sshd on
// port 22. The endpoint decodes to JSON with the client's SSH key ("key"),
// the sandbox host key ("host_key"), and the client's sandbox port ("port").
async function safeExpose(options: { reset?: boolean }): Promise<void> {
  const saved = options.reset ? undefined : getUserConfig("reverse_ssh")?.endpoint
  const endpoint = saved ?? (await askSecrets(["Endpoint"]))[0]
  const helper = await ensureProxyHelper(false)
  const helperPath = helper.split(path.sep).join("/")
  const quotedHelper = process.platform === "win32"
    ? `"${helperPath}"`
    : `'${helperPath.replace(/'/g, "'\\''")}'`
  const decoded = JSON.parse(Buffer.from(endpoint, "base64url").toString("utf8"))
  // Re-encode transport fields so ProxyCommand receives no shell syntax or SSH keys.
  // ssh passes its environment to ProxyCommand, keeping the value out of argv.
  const TUNNEL = tunnelValue(decoded, REVERSE_SSH_PORT)
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
        "[System.IO.File]::SetAccessControl($env:SSH_KEY_FILE, $acl)"
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
    "-o", `ProxyCommand=${quotedHelper.replace(/%/g, "%%")} ssh-tunnel`,
    "-R", `127.0.0.1:${decoded.port}:127.0.0.1:22`,
    "-i", keyFile,
    `tunnel${decoded.port}@sandbox`
  ], { stdio: ["inherit", "inherit", "pipe"], env: { ...process.env, TUNNEL } })
  const save = () => {
    updateUserConfig("reverse_ssh", { endpoint })
    console.error(`Saved endpoint to ${USER_CONFIG_PATH}`)
  }
  // Save once ssh logs in (OpenSSH prints this at LogLevel=VERBOSE), so a dropped tunnel still remembers.
  // Whether ssh printed "remote port forwarding failed", e.g. for port 2222.
  let remoteForwardFailed = false
  child.stderr!.on("data", (chunk) => {
    process.stderr.write(chunk)
    if (String(chunk).includes("Authenticated to ")) save()
    if (String(chunk).includes("remote port forwarding failed")) remoteForwardFailed = true
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
      if (remoteForwardFailed) {
        throw new Error(
          `sandbox port ${decoded.port} is already in use: another ` +
            "`hc safe-expose` with this endpoint is still connected, on this " +
            "or another computer. Stop it, then run this again"
        )
      } else {
        throw new Error(`ssh exited with code ${code}`)
      }
    }
    // Save on normal exit or Ctrl+C; SSH errors skip saving.
    save()
  } finally {
    process.off("SIGINT", onInterrupt)
  }
}

export function registerSafeExpose(program: Command): void {
  program
    .command("safe-expose")
    .description("let the sandbox reach this computer's SSH server (port 22)")
    .option("--reset", "ask for a new endpoint instead of the saved one")
    .action(safeExpose)
}
