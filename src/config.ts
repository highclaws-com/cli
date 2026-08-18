import fs from "node:fs"
import path from "node:path"
import dotenv from "dotenv"

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

export interface CliConfig {
  domain?: string
  swarm?: SshTarget[]
  pve?: SshTarget[]
  db?: SshTarget
  [key: string]: unknown
}

export interface LoadedConfig {
  root: string
  config: CliConfig
  env: Record<string, string>
}

const CONFIG_REL = path.join("secrets", "cli.json")

export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_REL))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`no repo root with ${CONFIG_REL} found above ${start}`)
    }
    dir = parent
  }
}

export function loadConfig(rootOverride?: string): LoadedConfig {
  const root = path.resolve(rootOverride ?? findRepoRoot())
  const configPath = path.join(root, CONFIG_REL)
  if (!fs.existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`)
  }
  let config: CliConfig
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CliConfig
  } catch (e) {
    throw new Error(`failed to parse ${configPath}: ${(e as Error).message}`)
  }
  return { root, config, env: loadEnv(root) }
}

export function loadEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  // mirror the sourcing order: config.env, then secrets/config.env overrides
  for (const rel of ["config.env", path.join("secrets", "config.env")]) {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) continue
    // files are in shell `export K=V` form; dotenv parses plain `K=V`
    const text = fs.readFileSync(file, "utf8").replace(/^export\s+/gm, "")
    Object.assign(env, dotenv.parse(text))
  }
  return env
}

export function extractEnv(env: Record<string, string>, keys: string[]): string[] {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === "")
  if (missing.length > 0) {
    throw new Error(`missing env var(s): ${missing.join(", ")}`)
  }
  return keys.map((k) => env[k] as string)
}
