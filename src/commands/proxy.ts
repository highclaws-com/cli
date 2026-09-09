import { execFileSync, spawn } from "node:child_process"
import readline from "node:readline/promises"
import { Command } from "commander"
import {
  ProxyConfig,
  getUserConfig,
  updateUserConfig
} from "../config"
import { ensureProxyHelper } from "../proxy-helper"

async function ask(
  rl: readline.Interface,
  label: string
): Promise<string> {
  return (await rl.question(`${label}: `)).trim()
}

function generateKeypair(helper: string): Pick<ProxyConfig, "privateKey" | "publicKey"> {
  const output = execFileSync(helper, ["keygen"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  })
  const keys = JSON.parse(output) as Partial<ProxyConfig>
  if (!keys.privateKey || !keys.publicKey) {
    throw new Error("proxy helper returned an invalid keypair")
  }
  return { privateKey: keys.privateKey, publicKey: keys.publicKey }
}

async function proxy(options: { reset: boolean; upgrade: boolean }): Promise<void> {
  const helper = await ensureProxyHelper(options.upgrade)
  if (options.reset) updateUserConfig("proxy", undefined)
  const saved = getUserConfig("proxy")
  let config: ProxyConfig
  if (saved) {
    config = saved
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const endpoint = await ask(rl, "Server WireGuard Endpoint")
    const serverPublicKey = await ask(
      rl,
      "Sandbox WireGuard Public Key"
    )
    rl.close()
    if (!endpoint || !serverPublicKey) {
      throw new Error("both values shown by the web UI are required")
    }
    config = { endpoint, serverPublicKey, ...generateKeypair(helper) }
    updateUserConfig("proxy", config)
  }

  console.log(`\nClient WireGuard Public Key:\n${config.publicKey}`)
  console.log("Paste this into the web UI, then turn on the Egress Proxy switch.")
  console.log("The proxy is running. Press Ctrl+C to stop it.\n")

  const child = spawn(helper, [
    "serve"
  ], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true })
  child.stdin.end(JSON.stringify(config))
  const stop = (): void => {
    child.kill()
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (exitCode, signal) => resolve(signal ? 0 : (exitCode ?? 1)))
  })
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
  if (code !== 0) throw new Error(`proxy helper exited with code ${code}`)
}

export function registerProxy(program: Command): void {
  program
    .command("proxy")
    .description("proxy sandbox browser egress through this computer")
    .option("--upgrade", "download the latest proxy helper")
    .option("--reset", "reset the saved configuration and client key")
    .action(proxy)
}
