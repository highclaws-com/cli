import path from "node:path"
import { Command } from "commander"
import { LoadedConfig, extractEnv } from "../../config"
import { escapeShell, run } from "../../exec"

interface ModelsOptions {
  contextLength?: boolean
  pool?: boolean
}

export function registerModels(admin: Command, getCtx: () => LoadedConfig): void {
  const models = admin
    .command("models")
    .description("inspect model configuration")
    .option("--context-length", "display the public model context lengths")
    .option("--pool", "display models available from the model pool")
    .action(async (opts: ModelsOptions) => {
      if (!opts.contextLength && !opts.pool) {
        models.outputHelp()
        return
      }

      const { config, env } = getCtx()
      if (!config.domain) {
        throw new Error("no 'domain' key in secrets/cli.json")
      }

      if (opts.contextLength) {
        const url = `https://${config.domain}/connectors/public/model-context`
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(`request failed: HTTP ${res.status} ${res.statusText}`)
        }
        const body = await res.text()
        let pretty = body
        try {
          pretty = JSON.stringify(JSON.parse(body), null, 2)
        } catch {
          // not JSON; display raw
        }
        console.log(pretty)
      }

      if (opts.pool) {
        const [managementKey] = extractEnv(env, ["GATEWAY_ADMIN_KEY"])
        const baseUrl = `https://model-pool.${config.domain}`
        const keysRes = await fetch(`${baseUrl}/v0/management/api-keys`, {
          headers: { Authorization: `Bearer ${managementKey}` }
        })
        if (!keysRes.ok) {
          throw new Error(`request failed: HTTP ${keysRes.status} ${keysRes.statusText}`)
        }
        const keysBody = await keysRes.json() as { "api-keys"?: string[] }
        const apiKey = keysBody["api-keys"]?.[0]
        if (!apiKey) {
          throw new Error("model pool has no API keys configured")
        }
        const modelsRes = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        })
        if (!modelsRes.ok) {
          throw new Error(`request failed: HTTP ${modelsRes.status} ${modelsRes.statusText}`)
        }
        const body = await modelsRes.text()
        let pretty = body
        try {
          pretty = JSON.stringify(JSON.parse(body), null, 2)
        } catch {
          // not JSON; display raw
        }
        console.log(pretty)
      }
    })

  models
    .command("scan")
    .description("scan model rows on the db node; extra args pass through to the script")
    .option("--remote-root <dir>", "source root on the db node", "~/highclaws-core")
    .argument("[extra ...]")
    .allowUnknownOption()
    .helpOption("--cli-help", "show this CLI help; pass --help to show the remote script help")
    .action(async (extra: string[], opts: { remoteRoot: string }) => {
      const { root, config, env } = getCtx()
      const target = config.db
      if (!target) {
        throw new Error("no 'db' entry in secrets/cli.json")
      }
      const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
      const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db`
      const key = path.join(root, target.ssh_key)
      const at = `${target.ssh_usr}@${target.ip}`
      const extras = extra.map(escapeShell).join(" ")
      const remote = [
        `cd ${opts.remoteRoot}`,
        `export PATH="$HOME/.local/bin:$PATH"`,
        `{ command -v uv >/dev/null 2>&1 || { wget -qO /tmp/uv-install.sh https://astral.sh/uv/install.sh && sh /tmp/uv-install.sh; }; }`,
        "git fetch --depth=1 origin deploy",
        "git checkout -B deploy origin/deploy",
        "git submodule update --init --recursive --recommend-shallow",
        `uv run scripts/db_scan_models.py ${escapeShell(sqlLink)}${extras ? " " + extras : ""}`
      ].join(" && ")
      console.log(`[models scan] db node ${target.ip}, remote root ${opts.remoteRoot}`)
      console.log(`$ ssh -i ${key} ${at} ${escapeShell(remote)}`)
      const rc = await run("ssh", ["-i", key, at, remote])
      if (rc !== 0) {
        throw new Error(`models scan failed (exit ${rc})`)
      }
    })
}
