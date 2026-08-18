import path from "node:path"
import { Command } from "commander"
import { LoadedConfig, extractEnv } from "../../config"
import { escapeShell, runCapture } from "../../exec"

interface DbOptions {
  entrypoint?: boolean
  lookupNode?: string
}

export function registerDb(admin: Command, getCtx: () => LoadedConfig): void {
  const db = admin
    .command("db")
    .description("database access entrypoints")
    .option("--entrypoint", "print web and ssh entrypoints for the db")
    .option("--lookup-node <node_id>", "fuzzy (substring) search a sandbox node_id and print its ProvisionVPS result")
    .action(async (opts: DbOptions) => {
      if (!opts.entrypoint && !opts.lookupNode) {
        db.outputHelp()
        return
      }
      const { root, config, env } = getCtx()
      const target = config.db
      if (!target) {
        throw new Error("no 'db' entry in secrets/cli.json")
      }
      const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
      const sshKey = path.join(root, target.ssh_key)

      if (opts.entrypoint) {
        const lines = ["db"]
        if (target.web_port) {
          lines.push(`  web : http://${target.ip}:${target.web_port}  (pgweb)`)
        }
        lines.push(
          `  url : postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`,
          `  user: ${dbUser}`,
          `  pass: ${dbPass}`,
          `  ssh : ssh -i ${sshKey} ${target.ssh_usr}@${target.ip}`
        )
        console.log(lines.join("\n"))
      }

      if (opts.lookupNode) {
        const sql = `SELECT vps.result FROM "Sandbox" sd JOIN "ProvisionVPS" vps ON sd.provision_id = vps.provision_id WHERE sd.node_id LIKE '%${opts.lookupNode}%';`
        const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
        const remote = `docker exec db_1-db-1 psql -v ON_ERROR_STOP=1 -X -q -A -t -d ${escapeShell(sqlLink)} -c ${escapeShell(sql)}`
        console.error(`[lookup-node] node_id=${opts.lookupNode} on db ${target.ip}`)
        console.error(`$ ssh -i ${sshKey} ${target.ssh_usr}@${target.ip} ${escapeShell(remote)}`)
        const { code, stdout } = await runCapture("ssh", ["-i", sshKey, `${target.ssh_usr}@${target.ip}`, remote])
        if (code !== 0) {
          throw new Error(`lookup-node failed (exit ${code})`)
        }
        const rows = stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0)
        if (rows.length === 0) {
          console.error(`no row found for node_id ${opts.lookupNode}`)
          return
        }
        const values = rows.map((row) => {
          try {
            return JSON.parse(row)
          } catch {
            return row
          }
        })
        console.log(JSON.stringify(values, null, 2))
      }
    })
}
