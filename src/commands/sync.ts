import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Command } from "commander"
import { hostBase } from "../api"
import { getUserConfig, updateUserConfig } from "../config"
import { run } from "../exec"
import { askSecrets } from "../output"
import {
  DEFAULT_VFS_CACHE_MODE,
  RCLONE_VFS_CACHE_DIR,
  ensureRclone
} from "../rclone"
import { ensureRsync } from "../rsync"

// The sandbox exposes exactly one sync token per node: the same rsyncd.secrets
// token authenticates both the rsync daemon (rsync@ password) and the WebDAV
// service (Basic password, username ignored).

// The rsync daemon uses the same token as the WebDAV service. The host:port is
// taken from the rsync:// target so a previously saved token can be reused.
function rsyncHost(args: string[]): string | undefined {
  for (const arg of args) {
    const match = /^rsync:\/\/(?:[^@/]+@)?([^/]+)/.exec(arg)
    if (match) return match[1]
  }
  return undefined
}

// The token store is keyed by WebDAV origin or rsync host:port. The token is
// asked for and saved when `ask` is set or none is saved.
async function syncToken(address: string | undefined, ask?: boolean): Promise<string> {
  // No address uses the "default" key.
  const key = address ?? "default"
  const tokens = getUserConfig("sync_token") ?? {}
  // An address with no saved token uses the default token.
  let token = ask ? undefined : tokens[key] ?? tokens.default
  if (!token) {
    [token] = await askSecrets(["Sync token"])
    updateUserConfig("sync_token", { ...tokens, [key]: token })
  }
  return token
}

async function obscure(executable: string, token: string): Promise<string> {
  // "-" reads the token from stdin, keeping it out of the process list.
  const result = spawnSync(executable, ["obscure", "-"], {
    input: token,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
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
  host: string,
  worktree: string,
  mountpoint: string,
  upgrade: boolean | undefined,
  cacheMode: string,
  ask?: boolean
): Promise<void> {
  const executable = await ensureRclone(upgrade)
  const token = await syncToken(hostBase(host), ask)
  const pass = await obscure(executable, token)
  const webdavURL = `${hostBase(host)}/webdav/${worktree}`

  console.log(`WebDAV URL: ${webdavURL}`)
  // Linux and macOS require the mountpoint to exist; WinFsp creates it and
  // rejects a mountpoint that is already there.
  if (process.platform !== "win32") {
    fs.mkdirSync(mountpoint, { recursive: true })
  }
  const args = [
    "mount",
    "HC_SYNC:",
    mountpoint,
    "--vfs-cache-mode",
    cacheMode,
    "--cache-dir",
    RCLONE_VFS_CACHE_DIR
  ]
  // Without this macOS labels the volume with the remote name instead of the
  // mountpoint.
  if (process.platform === "darwin") {
    args.push("--volname", path.basename(path.resolve(mountpoint)))
  }
  console.log(`Mounting ${mountpoint}. Press Ctrl+C to stop it.\n`)
  const code = await run(executable, args, {
    env: {
      RCLONE_CONFIG_HC_SYNC_TYPE: "webdav",
      RCLONE_CONFIG_HC_SYNC_URL: webdavURL,
      RCLONE_CONFIG_HC_SYNC_VENDOR: "other",
      RCLONE_CONFIG_HC_SYNC_USER: "rsync",
      RCLONE_CONFIG_HC_SYNC_PASS: pass
    }
  })
  if (code !== 0) throw new Error(`rclone exited with code ${code}`)
}

async function rsync(args: string[], ask?: boolean): Promise<void> {
  if (args.length === 0) {
    throw new Error("rsync arguments are required")
  }
  const executable = await ensureRsync()
  const token = await syncToken(rsyncHost(args), ask)
  const finalArgs = process.platform === "win32" ? cygwinArgs(args) : args
  console.log(`$ rsync ${finalArgs.join(" ")}\n`)
  const code = await run(executable, finalArgs, { env: { RSYNC_PASSWORD: token } })
  if (code !== 0) throw new Error(`rsync exited with code ${code}`)
}

export function registerSync(program: Command): void {
  const sync = program
    .command("sync")
    .description("sync files with a sandbox worktree")
    .option("--token", "ask for the sync token and save it, replacing the saved one")
    .action(async (options: { token?: boolean }) => {
      if (options.token) {
        await syncToken("default", true)
        console.log("Default sync token saved.")
      } else {
        sync.help()
      }
    })

  sync
    .command("mount <host> <worktree> <mountpoint>")
    .description("mount a sandbox worktree over WebDAV at the given mountpoint")
    .option(
      "--vfs-cache-mode <mode>",
      "rclone VFS cache mode (off|minimal|writes|full)",
      DEFAULT_VFS_CACHE_MODE
    )
    .option("--upgrade", "download the latest rclone")
    .action((host: string, worktree: string, mountpoint: string, _options: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as {
        token?: boolean
        upgrade?: boolean
        vfsCacheMode: string
      }
      return mount(host, worktree, mountpoint, opts.upgrade, opts.vfsCacheMode, opts.token)
    })

  sync
    .command("rsync [args...]")
    .description("run rsync against the sandbox with the synced token")
    .allowUnknownOption()
    .action((args: string[], _options: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as { token?: boolean }
      return rsync(args, opts.token)
    })
}
