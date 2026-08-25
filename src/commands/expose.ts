import { spawn } from "node:child_process"
import { Command, InvalidArgumentError } from "commander"
import { ensureCloudflared } from "../cloudflared"

async function expose(targetText: string, cloudflaredVersion: string): Promise<void> {
  const match = /^(tcp|https?):(\d+)$/.exec(targetText)
  if (!match) {
    throw new InvalidArgumentError("target must look like tcp:43817, http:43817, or https:43817")
  }
  const protocol = match[1]
  const port = Number(match[2])
  if (port < 1 || port > 65535) {
    throw new InvalidArgumentError("port must be from 1 to 65535")
  }
  const cloudflared = await ensureCloudflared(cloudflaredVersion)
  const child = spawn(
    cloudflared,
    ["tunnel", "--no-autoupdate", "--url", `${protocol}://127.0.0.1:${port}`],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
  )
  const stop = (): void => {
    child.kill()
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  let announced = false
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    process.stderr.write(chunk)
    if (announced) return
    const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(chunk)
    if (!match) return
    announced = true
    console.log()
    if (protocol === "tcp") {
      console.log(`Entrance: tcp://${match[1]}?port=${port}`)
    } else {
      console.log(`Entrance: https://${match[1]}`)
    }
  })
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (exitCode, signal) => resolve(signal ? 0 : (exitCode ?? 1)))
  })
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
  if (code !== 0) throw new Error(`cloudflared exited with code ${code}`)
}

export function registerExpose(program: Command): void {
  program
    .command("expose <target>")
    .description("expose a local TCP or HTTP service through Cloudflare")
    .addHelpText(
      "after",
      "\nExamples:\n  hc expose tcp:43817\n  hc expose http:8000\n  hc expose https:8443"
    )
    .action((target: string, _options: unknown, command: Command) =>
      expose(target, command.optsWithGlobals().cloudflaredVersion as string)
    )
}
