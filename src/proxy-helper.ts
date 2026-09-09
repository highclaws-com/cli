import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ASSETS: Record<string, string> = {
  "linux-x64": "hc-proxy-linux-amd64",
  "linux-arm64": "hc-proxy-linux-arm64",
  "darwin-x64": "hc-proxy-darwin-amd64",
  "darwin-arm64": "hc-proxy-darwin-arm64",
  "win32-x64": "hc-proxy-windows-amd64.exe"
}

function cacheRoot(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "hc-cli")
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "hc-cli")
}

export async function ensureProxyHelper(): Promise<string> {
  const platform = `${process.platform}-${process.arch}`
  const asset = ASSETS[platform]
  if (!asset) throw new Error(`browser egress proxy is not available for ${platform}`)

  const dir = path.join(cacheRoot(), "proxy-helper", platform)
  const executable = path.join(dir, process.platform === "win32" ? "hc-proxy.exe" : "hc-proxy")
  fs.mkdirSync(dir, { recursive: true })
  console.error(`Downloading browser egress proxy helper for ${platform}...`)
  const response = await fetch(
    `https://github.com/highclaws-com/cli/releases/download/proxy-helper-deploy/${asset}`,
    { redirect: "follow" }
  )
  if (!response.ok) throw new Error(`proxy helper download failed: HTTP ${response.status}`)
  fs.writeFileSync(executable, Buffer.from(await response.arrayBuffer()), { mode: 0o700 })
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700)
  return executable
}
