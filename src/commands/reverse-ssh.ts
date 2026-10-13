import fs from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import readline from "node:readline/promises"
import { Command } from "commander"
import { USER_CACHE_DIR, getUserConfig, updateUserConfig } from "../config"
import { run } from "../exec"

// Reverse-forwards the sandbox's 127.0.0.1:2222 to this computer's sshd on
// port 22. The key is base64 of
// {"key": "<OpenSSH private key>", "host_key": "ssh-ed25519 ..."}.
async function reverseSsh(options: {
  endpoint?: string
  key?: string
  reset?: boolean
}): Promise<void> {
  if (options.reset) updateUserConfig("reverse_ssh", undefined)
  const saved = getUserConfig("reverse_ssh")
  let endpoint = options.endpoint ?? saved?.endpoint
  let key = options.key ?? saved?.key
  if (!endpoint || !key) {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      if (!endpoint) endpoint = (await prompt.question("Sandbox IP:PORT: ")).trim()
      if (!key) key = (await prompt.question("Sandbox key (base64): ")).trim()
    } finally {
      prompt.close()
    }
  }

  const decoded = JSON.parse(Buffer.from(key, "base64").toString("utf8"))
  const dir = path.join(USER_CACHE_DIR, "reverse-ssh")
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

  const [ip, port] = endpoint.split(":")
  const child = spawn("ssh", [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "LogLevel=VERBOSE",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "HostKeyAlias=sandbox",
    "-o", `UserKnownHostsFile="${knownHostsFile.split(path.sep).join("/")}"`,
    "-o", "StrictHostKeyChecking=yes",
    "-R", "127.0.0.1:2222:127.0.0.1:22",
    "-i", keyFile,
    "-p", port,
    `tunnel@${ip}`
  ], { stdio: "inherit" })
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
    // Save on normal exit or Ctrl+C; SSH errors skip saving.
    updateUserConfig("reverse_ssh", { endpoint, key })
  } finally {
    process.off("SIGINT", onInterrupt)
  }
}

export function registerReverseSsh(program: Command): void {
  program
    .command("reverse-ssh")
    .description("let the sandbox reach this computer's SSH server (port 22)")
    .option("--endpoint <ip:port>", "sandbox IP and SSH tunnel port; saved")
    .option("--key <key>", "base64 key from `hc sandbox get-ssh-key`; saved")
    .option("--reset", "clear saved endpoint and key")
    .action(reverseSsh)
}
