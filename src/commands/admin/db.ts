import path from "node:path"
import { Command } from "commander"
import { LoadedConfig, extractEnv } from "../../config"

interface DbOptions {
  entrypoint?: boolean
}

export function registerDb(admin: Command, getCtx: () => LoadedConfig): void {
  const db = admin
    .command("db")
    .description("database access entrypoints")
    .option("--entrypoint", "print web and ssh entrypoints for the db")
    .action((opts: DbOptions) => {
      if (!opts.entrypoint) {
        db.outputHelp()
        return
      }
      const { root, config, env } = getCtx()
      const target = config.db
      if (!target) {
        throw new Error("no 'db' entry in secrets/cli.json")
      }
      if (!target.container) {
        throw new Error("no 'container' key for db in secrets/cli.json")
      }
      const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
      const sshKey = path.join(root, target.ssh_key)

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
    })
}
