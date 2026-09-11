import fs from "node:fs"
import path from "node:path"
import { unzipSync } from "fflate"
import { USER_CACHE_DIR } from "./config"

export const DEFAULT_RCLONE_VERSION = "v1.75.1"

// rclone's VFS cache (read-ahead/full-file cache) lives under the standard
// per-user cache dir, alongside the downloaded rclone binary.
export const RCLONE_VFS_CACHE_DIR = path.join(USER_CACHE_DIR, "rclone", "cache")

// Cache reads as well as writes. The WebDAV backend is a high-latency network
// remote, so the default `writes` mode makes every random read (image viewers,
// editors, anything that seeks) a fresh round trip and is unusably slow. `full`
// downloads a file once on first access and serves subsequent reads locally.
export const DEFAULT_VFS_CACHE_MODE = "full"

const PLATFORMS: Record<string, string> = {
  "linux-x64": "linux-amd64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "osx-amd64",
  "darwin-arm64": "osx-arm64",
  "win32-x64": "windows-amd64"
}

export async function ensureRclone(version = DEFAULT_RCLONE_VERSION): Promise<string> {
  const platform = `${process.platform}-${process.arch}`
  const flavor = PLATFORMS[platform]
  if (!flavor) throw new Error(`rclone is not available for ${platform}`)

  const dir = path.join(USER_CACHE_DIR, "rclone", version, platform)
  const executable = path.join(dir, process.platform === "win32" ? "rclone.exe" : "rclone")
  if (fs.existsSync(executable)) return executable

  fs.mkdirSync(dir, { recursive: true })
  console.error(`Downloading rclone ${version} for ${platform}...`)
  const response = await fetch(
    `https://github.com/rclone/rclone/releases/download/${version}/rclone-${version}-${flavor}.zip`,
    { redirect: "follow" }
  )
  if (!response.ok) throw new Error(`rclone download failed: HTTP ${response.status}`)
  const files = unzipSync(new Uint8Array(Buffer.from(await response.arrayBuffer())))
  const member = Object.keys(files).find((name) => /(^|\/)rclone(\.exe)?$/.test(name))
  if (!member) throw new Error("unrecognized rclone archive layout")
  fs.writeFileSync(executable, files[member])
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700)
  return executable
}
