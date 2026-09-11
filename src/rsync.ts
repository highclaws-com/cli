import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { unzipSync } from "fflate"
import { USER_CACHE_DIR } from "./config"

// Windows has no rsync. The cwRsync free client is a digitally signed rsync.exe
// bundled with the Cygwin libraries it needs, so it runs without cygwin.
export const CWRSYNC_VERSION = "6.4.8"
const CWRSYNC_SHA256 = "8798363513b05c355ad87f8f3efbb15b7b6433996b652efec712efd52d7c8336"

export async function ensureRsync(): Promise<string> {
  if (process.platform !== "win32") return "rsync"

  const dir = path.join(USER_CACHE_DIR, "rsync", CWRSYNC_VERSION)
  const executable = path.join(dir, "bin", "rsync.exe")
  if (fs.existsSync(executable)) return executable

  const url = `https://itefix.net/dl/free-software/cwrsync_${CWRSYNC_VERSION}_x64_free.zip`
  console.error(`Downloading rsync ${CWRSYNC_VERSION} for Windows...`)
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`rsync download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const digest = createHash("sha256").update(archive).digest("hex")
  if (digest !== CWRSYNC_SHA256) throw new Error("rsync download checksum mismatch")

  const files = unzipSync(new Uint8Array(archive))
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
  return executable
}
