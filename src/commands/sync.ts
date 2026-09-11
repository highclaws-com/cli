import fs from "node:fs"
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
  baseAddress: string
  subpath: string
}

// Rewrite a WebDAV address embedded in rclone arguments into a remote that
// authenticates with the synced token: the origin becomes the remote URL and
// the path becomes the remote path.
function webdavRemote(arg: string): SyncAddress | undefined {
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(arg)
  return match ? { baseAddress: match[1], subpath: match[2] ?? "" } : undefined
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

function syncToken(address: string | undefined, explicitToken?: string): string {
  const tokens = getUserConfig("sync_token") ?? {}
  if (explicitToken) {
    if (address) updateUserConfig("sync_token", { ...tokens, [address]: explicitToken })
    return explicitToken
  } else if (address && tokens[address]) {
    return tokens[address]
  } else {
    const targetDesc = address ? ` for ${address}` : ""
    throw new Error(`sync token is required${targetDesc}: provide --token <token>`)
  }
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
  const token = syncToken(parsed.baseAddress, explicitToken)
  const pass = await obscure(executable, token)

  console.log(`WebDAV URL: ${parsed.baseAddress}${parsed.subpath}`)
  // Linux and macOS require the mountpoint to exist; WinFsp creates it and
  // rejects a mountpoint that is already there.
  if (process.platform !== "win32") {
    fs.mkdirSync(mountpoint, { recursive: true })
  }
  console.log(`Mounting ${mountpoint}. Press Ctrl+C to stop it.\n`)
  const code = await run(executable, [
    "mount",
    `HC_SYNC:${parsed.subpath}`,
    mountpoint,
    "--vfs-cache-mode", "writes"
  ], {
    env: {
      RCLONE_CONFIG_HC_SYNC_TYPE: "webdav",
      RCLONE_CONFIG_HC_SYNC_URL: parsed.baseAddress,
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
