import path from "node:path"
import { Command } from "commander"
import { LoadedConfig, extractEnv } from "../../config"
import { run } from "../../exec"

function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export function registerModels(admin: Command, getCtx: () => LoadedConfig): void {
  const models = admin
    .command("models")
    .description("fetch and display the public model context")
    .action(async () => {
      const { config } = getCtx()
      if (!config.domain) {
        throw new Error("no 'domain' key in secrets/cli.json")
      }
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
      const extras = extra.map(q).join(" ")
      const remote = [
        `cd ${opts.remoteRoot}`,
        `export PATH="$HOME/.local/bin:$PATH"`,
        `{ command -v uv >/dev/null 2>&1 || { wget -qO /tmp/uv-install.sh https://astral.sh/uv/install.sh && sh /tmp/uv-install.sh; }; }`,
        "git fetch --depth=1 origin deploy",
        "git checkout deploy",
        "git submodule update --init --recursive --recommend-shallow",
        `uv run scripts/db_scan_models.py ${q(sqlLink)}${extras ? " " + extras : ""}`
      ].join(" && ")
      console.log(`[models scan] db node ${target.ip}, remote root ${opts.remoteRoot}`)
      console.log(`$ ssh -i ${key} ${at} ${q(remote)}`)
      const rc = await run("ssh", ["-i", key, at, remote])
      if (rc !== 0) {
        throw new Error(`models scan failed (exit ${rc})`)
      }
    })
}
