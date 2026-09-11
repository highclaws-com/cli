import fs from "node:fs"
import path from "node:path"
import { GITHUB_ORG, USER_CACHE_DIR } from "./config"

const ASSETS: Record<string, string> = {
  "linux-x64": "hc-proxy-linux-amd64",
  "linux-arm64": "hc-proxy-linux-arm64",
  "darwin-x64": "hc-proxy-darwin-amd64",
  "darwin-arm64": "hc-proxy-darwin-arm64",
  "win32-x64": "hc-proxy-windows-amd64.exe"
}

export async function ensureProxyHelper(upgrade: boolean): Promise<string> {
  const platform = `${process.platform}-${process.arch}`
  const asset = ASSETS[platform]
  if (!asset) throw new Error(`browser egress proxy is not available for ${platform}`)

  const dir = path.join(USER_CACHE_DIR, "proxy-helper", platform)
  const executable = path.join(dir, process.platform === "win32" ? "hc-proxy.exe" : "hc-proxy")
  if (!upgrade && fs.existsSync(executable)) return executable

  fs.mkdirSync(dir, { recursive: true })
  console.error(`Downloading browser egress proxy helper for ${platform}...`)
  const response = await fetch(
    `https://github.com/${GITHUB_ORG}/cli/releases/download/proxy-helper/${asset}`,
    { redirect: "follow" }
  )
  if (!response.ok) throw new Error(`proxy helper download failed: HTTP ${response.status}`)
  fs.writeFileSync(executable, Buffer.from(await response.arrayBuffer()), { mode: 0o700 })
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700)
  return executable
}
