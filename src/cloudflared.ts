import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEFAULT_CLOUDFLARED_VERSION = "2026.8.2"

const ASSETS: Record<string, string> = {
  "linux-x64": "cloudflared-linux-amd64",
  "linux-arm64": "cloudflared-linux-arm64",
  "darwin-x64": "cloudflared-darwin-amd64.tgz",
  "darwin-arm64": "cloudflared-darwin-arm64.tgz",
  "win32-x64": "cloudflared-windows-amd64.exe"
}

function cacheRoot(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "hc-cli")
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "hc-cli")
}

export async function ensureCloudflared(version = DEFAULT_CLOUDFLARED_VERSION): Promise<string> {
  const platform = `${process.platform}-${process.arch}`
  const asset = ASSETS[platform]
  if (!asset) throw new Error(`cloudflared is not available for ${platform}`)

  const dir = path.join(cacheRoot(), "cloudflared", version, platform)
  const executable = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared")
  if (fs.existsSync(executable)) return executable

  fs.mkdirSync(dir, { recursive: true })
  console.error(`Downloading cloudflared ${version} for ${platform}...`)
  const response = await fetch(
    `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`,
    { redirect: "follow" }
  )
  if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`)
  const downloaded = Buffer.from(await response.arrayBuffer())

  if (asset.endsWith(".tgz")) {
    const archive = path.join(dir, asset)
    fs.writeFileSync(archive, downloaded)
    execFileSync("tar", ["-xzf", archive, "-C", dir])
    fs.unlinkSync(archive)
  } else {
    fs.writeFileSync(executable, downloaded, { mode: 0o700 })
  }
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700)
  return executable
}
