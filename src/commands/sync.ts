import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Command } from "commander"
import { getUserConfig, updateUserConfig } from "../config"
import { run } from "../exec"
import { DEFAULT_RCLONE_VERSION, ensureRclone } from "../rclone"
import { ensureRsync } from "../rsync"

// The sandbox exposes exactly one sync token per node: the same rsyncd.secrets
// token authenticates both the rsync daemon (rsync@ password) and the WebDAV
// service (Basic password, username ignored).

interface SyncAddress {
  tokenAddress: string
  webdavURL: string
}

// The full WebDAV address becomes the rclone backend URL and the remote root
// stays empty, so rclone's Statfs/About PROPFINDs the configured path itself.
// Keeping the path in the remote instead would make About() query the origin
// and 404. The origin alone keys the saved token.
function webdavRemote(arg: string): SyncAddress | undefined {
  try {
    const url = new URL(arg)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return { tokenAddress: url.origin, webdavURL: arg }
  } catch {
    return undefined
  }
}

// The rsync daemon uses the same token as the WebDAV service. The host:port is
// taken from the rsync:// target so a previously saved token can be reused.
function rsyncHost(args: string[]): string | undefined {
  for (const arg of args) {
    const match = /^rsync:\/\/(?:[^@/]+@)?([^/]+)/.exec(arg)
    if (match) return match[1]
  }
  return undefined
}

// The token store is keyed by WebDAV origin or rsync host:port.
function syncToken(address: string | undefined, explicitToken?: string): string {
  // No address uses the "default" key.
  const key = address ?? "default"
  const tokens = getUserConfig("sync_token") ?? {}
  if (explicitToken) {
    updateUserConfig("sync_token", { ...tokens, [key]: explicitToken })
    return explicitToken
  }
  // An address with no saved token uses the default token.
  const token = tokens[key] ?? tokens.default
  if (!token) {
    throw new Error("sync token is required: provide --token <token>")
  }
  return token
}

async function obscure(executable: string, token: string): Promise<string> {
  const result = spawnSync(executable, ["obscure", token], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(`rclone obscure failed with code ${result.status}`)
  }
  return result.stdout.trim()
}

// cwRsync is a Cygwin build and expects POSIX paths, but Windows users type
// native paths. Convert local path operands to Cygwin form; options and
// rsync:// remotes are left untouched.
function cygwinArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (arg.startsWith("-") || arg.startsWith("rsync://")) {
      return arg
    } else {
      const drive = /^([A-Za-z]):[\\/](.*)$/.exec(arg)
      if (drive) {
        return `/cygdrive/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`
      } else {
        return arg.replace(/\\/g, "/")
      }
    }
  })
}

async function mount(
  address: string,
  mountpoint: string,
  version: string,
  explicitToken?: string
): Promise<void> {
  const executable = await ensureRclone(version)
  const parsed = webdavRemote(address)
  if (!parsed) throw new Error(`invalid sandbox address: ${address}`)
  const token = syncToken(parsed.tokenAddress, explicitToken)
  const pass = await obscure(executable, token)

  console.log(`WebDAV URL: ${parsed.webdavURL}`)
  // Linux and macOS require the mountpoint to exist; WinFsp creates it and
  // rejects a mountpoint that is already there.
  if (process.platform !== "win32") {
    fs.mkdirSync(mountpoint, { recursive: true })
  }
  const args = ["mount", "HC_SYNC:", mountpoint, "--vfs-cache-mode", "writes"]
  // Without this macOS labels the volume with the remote name instead of the
  // mountpoint.
  if (process.platform === "darwin") {
    args.push("--volname", path.basename(path.resolve(mountpoint)))
  }
  console.log(`Mounting ${mountpoint}. Press Ctrl+C to stop it.\n`)
  const code = await run(executable, args, {
    env: {
      RCLONE_CONFIG_HC_SYNC_TYPE: "webdav",
      RCLONE_CONFIG_HC_SYNC_URL: parsed.webdavURL,
      RCLONE_CONFIG_HC_SYNC_VENDOR: "other",
      RCLONE_CONFIG_HC_SYNC_USER: "rsync",
      RCLONE_CONFIG_HC_SYNC_PASS: pass
    }
  })
  if (code !== 0) throw new Error(`rclone exited with code ${code}`)
}

async function rsync(args: string[], explicitToken?: string): Promise<void> {
  if (args.length === 0) {
    throw new Error("rsync arguments are required")
  }
  const executable = await ensureRsync()
  const token = syncToken(rsyncHost(args), explicitToken)
  const finalArgs = process.platform === "win32" ? cygwinArgs(args) : args
  console.log(`$ rsync ${finalArgs.join(" ")}\n`)
  const code = await run(executable, finalArgs, { env: { RSYNC_PASSWORD: token } })
  if (code !== 0) throw new Error(`rsync exited with code ${code}`)
}

export function registerSync(program: Command): void {
  const sync = program
    .command("sync")
    .description("sync files with a sandbox worktree")
    .option("--token <token>", "sync token; saved to config once specified")
    .option("--rclone-version <version>", "rclone release tag", DEFAULT_RCLONE_VERSION)
    .action((options: { token?: string }) => {
      if (options.token) {
        syncToken("default", options.token)
        console.log("Default sync token saved.")
      } else {
        sync.help()
      }
    })

  sync
    .command("mount <address> <mountpoint>")
    .description("mount the sandbox WebDAV tree over the given mountpoint")
    .action((address: string, mountpoint: string, _options: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as { token?: string; rcloneVersion: string }
      return mount(address, mountpoint, opts.rcloneVersion, opts.token)
    })

  sync
    .command("rsync [args...]")
    .description("run rsync against the sandbox with the synced token")
    .allowUnknownOption()
    .action((args: string[], _options: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as { token?: string }
      return rsync(args, opts.token)
    })
}
