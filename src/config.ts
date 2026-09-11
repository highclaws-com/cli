import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import dotenv from "dotenv"

export const APP_NAME = "highclaws"
export const APP_DOMAIN = "highclaws.com"
export const GITHUB_ORG = "highclaws-com"

export interface SshTarget {
  ip: string
  ssh_key: string
  ssh_usr: string
  container?: string
  src_path?: string
  manager?: boolean
  web_port?: number
  web_pass?: string
}

export interface DashboardEntry {
  url: string
  memo?: string
}

export interface PveBaseImage {
  url_prefix?: string
  url_path?: string
  url_img?: string
}

export interface AdminConfig {
  domain?: string
  dashboards?: Record<string, DashboardEntry>
  swarm?: SshTarget[]
  pve?: SshTarget[]
  db?: SshTarget
  pve_base_image?: PveBaseImage
  [key: string]: unknown
}

export interface AdminContext {
  root: string
  adminConfig: AdminConfig
  env: Record<string, string>
}

export interface AuthConfig {
  jwt: string
}

const ADMIN_CONFIG_REL = path.join("secrets", "cli.json")
const USER_CONFIG_DIR = process.platform === "win32"
  ? path.join(process.env.APPDATA ?? os.homedir(), APP_NAME)
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", APP_NAME)
    : path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      APP_NAME
    )
export const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, "config.json")
const USER_CONFIG_LOCK_PATH = `${USER_CONFIG_PATH}.lock`

export const USER_CACHE_DIR = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), APP_NAME)
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", APP_NAME)
    : path.join(
      process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
      APP_NAME
    )

export interface ProxyConfig {
  endpoint: string
  serverPublicKey: string
  privateKey: string
  publicKey: string
}

export interface UserConfig {
  auth?: AuthConfig
  proxy?: ProxyConfig
  sync_token?: Record<string, string>
}

function withUserConfig<T>(callback: (config: UserConfig) => T): T {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 5000
  let lock: number
  for (;;) {
    try {
      lock = fs.openSync(USER_CONFIG_LOCK_PATH, "wx", 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for config lock: ${USER_CONFIG_LOCK_PATH}`)
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try {
    const config = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as UserConfig
      : {}
    return callback(config)
  } finally {
    fs.closeSync(lock)
    fs.unlinkSync(USER_CONFIG_LOCK_PATH)
  }
}

export function getUserConfig<K extends keyof UserConfig>(
  key: K
): UserConfig[K] {
  return withUserConfig((config) => config[key])
}

export function updateUserConfig<K extends keyof UserConfig>(
  key: K,
  value: UserConfig[K]
): void {
  withUserConfig((config) => {
    if (value === undefined) {
      delete config[key]
    } else {
      config[key] = value
    }
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600
    })
  })
}

export function loadAdminContext(rootOverride?: string): AdminContext {
  let root = path.resolve(rootOverride ?? process.cwd())
  while (rootOverride === undefined && !fs.existsSync(path.join(root, ADMIN_CONFIG_REL))) {
    const parent = path.dirname(root)
    if (parent === root) {
      throw new Error(`no repo root with ${ADMIN_CONFIG_REL} found`)
    }
    root = parent
  }
  const configPath = path.join(root, ADMIN_CONFIG_REL)
  let adminConfig: AdminConfig
  try {
    adminConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as AdminConfig
  } catch (e) {
    throw new Error(`failed to parse ${configPath}: ${(e as Error).message}`)
  }
  const env: Record<string, string> = {}
  // mirror the sourcing order: config.env, then secrets/config.env overrides
  for (const rel of ["config.env", path.join("secrets", "config.env")]) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) continue
    // files are in shell `export K=V` form; dotenv parses plain `K=V`
    const text = fs.readFileSync(file, "utf8").replace(/^export\s+/gm, "")
    Object.assign(env, dotenv.parse(text))
  }
  return { root, adminConfig, env }
}

export function extractEnv(env: Record<string, string>, keys: string[]): string[] {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === "")
  if (missing.length > 0) {
    throw new Error(`missing env var(s): ${missing.join(", ")}`)
  }
  return keys.map((k) => env[k] as string)
}
