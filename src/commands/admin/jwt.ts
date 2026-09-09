import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Command } from "commander"
import { AdminContext } from "../../config"
import { runCapture } from "../../exec"

interface JwtOptions {
  uid: string
  hijackKey: string
  hijackDomain: string
  openUrl: string
}

function findBrowser(): string {
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error("Chrome or Chromium was not found in PATH")
}

async function waitForCdp(profileDir: string): Promise<number> {
  const portFile = path.join(profileDir, "DevToolsActivePort")
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0])
      if (Number.isInteger(port)) return port
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("browser CDP did not start")
}

async function cdpCall(
  socket: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: Record<string, unknown>
        error?: { message?: string }
      }
      if (message.id !== id) return
      socket.removeEventListener("message", onMessage)
      if (message.error) {
        reject(new Error(message.error.message || `${method} failed`))
      } else {
        resolve(message.result || {})
      }
    }
    socket.addEventListener("message", onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function loginBrowser(
  token: string,
  key: string,
  domain: string,
  openUrl: string
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("browser login is supported on Linux only")
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "highclaws-browser-"))
  const browser = spawn(
    findBrowser(),
    [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=http://127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ],
    { detached: true, stdio: "ignore" }
  )
  browser.unref()

  const port = await waitForCdp(profileDir)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()) as Array<{
    type?: string
    webSocketDebuggerUrl?: string
  }>
  const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl)
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("browser page target was not found")
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("failed to connect to browser CDP")), {
      once: true
    })
  })
  await cdpCall(socket, 1, "Network.enable")
  const result = await cdpCall(socket, 2, "Network.setCookie", {
    name: key,
    value: token,
    domain,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax"
  })
  if (result.success !== true) {
    throw new Error("browser rejected the login cookie")
  }
  await cdpCall(socket, 3, "Page.navigate", { url: openUrl })
  socket.close()
}

export function registerJwt(admin: Command, getCtx: () => AdminContext): void {
  admin
    .command("jwt")
    .description("generate a short-lived JWT for a user")
    .requiredOption("--uid <uid>", "user UID")
    .option("--hijack-key <key>", "cookie name for browser login", "JWT_Token")
    .option("--hijack-domain <domain>", "cookie domain for browser login", ".highclaws.com")
    .option("--open-url <url>", "URL to open after browser login", "https://highclaws.com")
    .action(async (opts: JwtOptions) => {
      const uid = Number(opts.uid)
      if (!Number.isSafeInteger(uid) || uid <= 0) {
        throw new Error("--uid must be a positive integer")
      }
      const { root, adminConfig } = getCtx()
      const manager = (adminConfig.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }

      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const container = `$(${docker} ps -q --filter 'name=rq_api[^_]' | head -n 1)`
      const remote =
        `${docker} exec ${container} curl -fsS ` +
        `http://localhost:8000/api/v1/jwt/${uid} -H 'X-User-Uid: 1'`
      const key = path.join(root, manager.ssh_key)
      const at = `${manager.ssh_usr}@${manager.ip}`
      const { code, stdout } = await runCapture("ssh", ["-i", key, at, remote])
      if (code !== 0) {
        throw new Error(`JWT generation failed (exit ${code})`)
      }

      const body = JSON.parse(stdout) as { token?: unknown }
      if (typeof body.token !== "string") {
        throw new Error("response did not include a JWT")
      }
      await loginBrowser(body.token, opts.hijackKey, opts.hijackDomain, opts.openUrl)
    })
}
