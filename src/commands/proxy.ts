import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"
import { Command } from "commander"
import { ensureProxyHelper } from "../proxy-helper"

interface ProxyConfig {
  endpoint: string
  serverPublicKey: string
  privateKey: string
  publicKey: string
}

function configPath(): string {
  return path.join(os.homedir(), ".config", "highclaws", "proxy.json")
}

function loadProxyConfig(): Partial<ProxyConfig> {
  const file = configPath()
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProxyConfig>
  } catch (error) {
    throw new Error(`failed to read ${file}: ${(error as Error).message}`)
  }
}

function saveProxyConfig(config: ProxyConfig): void {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(file), 0o700)
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

async function ask(
  rl: readline.Interface,
  label: string,
  current?: string
): Promise<string> {
  const answer = (await rl.question(`${label}${current ? ` [${current}]` : ""}: `)).trim()
  return answer || current || ""
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

async function proxy(upgrade: boolean): Promise<void> {
  const helper = await ensureProxyHelper(upgrade)
  const saved = loadProxyConfig()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const endpoint = await ask(rl, "Server WireGuard Endpoint", saved.endpoint)
  const serverPublicKey = await ask(
    rl,
    "Sandbox WireGuard Public Key",
    saved.serverPublicKey
  )
  rl.close()
  if (!endpoint || !serverPublicKey) {
    throw new Error("both values shown by the web UI are required")
  }

  const keys = saved.privateKey && saved.publicKey
    ? { privateKey: saved.privateKey, publicKey: saved.publicKey }
    : generateKeypair(helper)
  saveProxyConfig({ endpoint, serverPublicKey, ...keys })

  console.log(`\nClient WireGuard Public Key:\n${keys.publicKey}`)
  console.log("Paste this into the web UI, then turn on the Egress Proxy switch.")
  console.log("The proxy is running. Press Ctrl+C to stop it.\n")

  const child = spawn(helper, [
    "serve",
    "--config", configPath()
  ], { stdio: "inherit", windowsHide: true })
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
    .action((options: { upgrade: boolean }) => proxy(options.upgrade))
}
