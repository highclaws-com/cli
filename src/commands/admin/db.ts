import path from "node:path"
import { Command } from "commander"
import { LoadedConfig, extractEnv } from "../../config"
import { escapeShell, runCapture } from "../../exec"

interface DbOptions {
  entrypoint?: boolean
  lookupNode?: string
  removeNode?: string
  sshNode?: string
}

export function registerDb(admin: Command, getCtx: () => LoadedConfig): void {
  const db = admin
    .command("db")
    .description("database access entrypoints")
    .option("--entrypoint", "print web and ssh entrypoints for the db")
    .option("--lookup-node <node_id>", "fuzzy (substring) search a sandbox node_id and print its ProvisionVPS result")
    .option("--remove-node <node_id>", "delete all database rows for a sandbox node")
    .option("--ssh-node <node_id>", "fuzzy (substring) search a sandbox node_id and print ready-to-paste ssh commands")
    .action(async (opts: DbOptions) => {
      if (!opts.entrypoint && !opts.lookupNode && !opts.removeNode && !opts.sshNode) {
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

      if (opts.removeNode) {
        const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
        const sql = `
          WITH node AS (
            SELECT provision_id FROM "Sandbox" WHERE node_id = '${opts.removeNode}'
          ),
          vps AS (
            DELETE FROM "ProvisionVPS" USING node
            WHERE "ProvisionVPS".provision_id = node.provision_id
          ),
          bkt AS (
            DELETE FROM "ProvisionBkt" USING node
            WHERE "ProvisionBkt".provision_id = node.provision_id
          ),
          proxy AS (
            DELETE FROM "ProvisionProxy" USING node
            WHERE "ProvisionProxy".provision_id = node.provision_id
          ),
          model_keys AS (
            DELETE FROM "ModelKeys" USING node
            WHERE "ModelKeys".provision_id = node.provision_id
          ),
          exclusive_keys AS (
            DELETE FROM "SandboxExclusiveKey" USING node
            WHERE "SandboxExclusiveKey".provision_id = node.provision_id
          ),
          reloads AS (
            DELETE FROM "SandboxReload" USING node
            WHERE "SandboxReload".provision_id = node.provision_id
          ),
          sandbox AS (
            DELETE FROM "Sandbox" USING node
            WHERE "Sandbox".provision_id = node.provision_id
          )
          SELECT provision_id FROM node;
        `
        const remote = `docker exec db_1-db-1 psql -v ON_ERROR_STOP=1 -X -q -A -t` +
          ` -d ${escapeShell(sqlLink)} -c ${escapeShell(sql)}`
        const { code, stdout } = await runCapture(
          "ssh", ["-i", sshKey, `${target.ssh_usr}@${target.ip}`, remote]
        )
        if (code !== 0) {
          throw new Error(`row deletion failed (exit ${code})`)
        }
        const provisionId = stdout.trim()
        if (!provisionId) throw new Error(`node not found: ${opts.removeNode}`)
        console.log(`deleted node ${opts.removeNode} (provision_id: ${provisionId})`)
        return
      }

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

      if (opts.lookupNode || opts.sshNode) {
        const tag = opts.sshNode ? "ssh-node" : "lookup-node"
        const nodeId = opts.sshNode ?? opts.lookupNode
        const sql = `SELECT vps.result FROM "Sandbox" sd JOIN "ProvisionVPS" vps ON sd.provision_id = vps.provision_id WHERE sd.node_id LIKE '%${nodeId}%';`
        const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
        const remote = `docker exec db_1-db-1 psql -v ON_ERROR_STOP=1 -X -q -A -t -P null=null -d ${escapeShell(sqlLink)} -c ${escapeShell(sql)}`
        console.error(`[${tag}] node_id=${nodeId} on db ${target.ip}`)
        console.error(`$ ssh -i ${sshKey} ${target.ssh_usr}@${target.ip} ${escapeShell(remote)}`)
        const { code, stdout } = await runCapture("ssh", ["-i", sshKey, `${target.ssh_usr}@${target.ip}`, remote])
        if (code !== 0) {
          throw new Error(`${tag} failed (exit ${code})`)
        }
        const rows = stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0)
        if (rows.length === 0) {
          console.error(`no row found for node_id ${nodeId}`)
          return
        }
        const values = rows.map((row) => {
          try {
            return JSON.parse(row)
          } catch {
            return row
          }
        })
        if (opts.sshNode) {
          const nodeUser = config.swarm?.[0]?.ssh_usr
          if (!nodeUser) {
            throw new Error("no swarm entry with ssh_usr in secrets/cli.json")
          }
          for (const v of values) {
            console.log(JSON.stringify(v, null, 2))
            if (typeof v !== "object" || v === null || !Array.isArray(v.public_ips) || !v.public_ips[0] || v.ssh_port === undefined) {
              throw new Error("ProvisionVPS result missing public_ips/ssh_port")
            }
            console.log(`\x1b[1;32m ssh-keygen -R "[${v.public_ips[0]}]:${v.ssh_port}" \x1b[0m`)
            console.log(`\x1b[1;32m ssh -i ${target.ssh_key} -p ${v.ssh_port} ${nodeUser}@${v.public_ips[0]} \x1b[0m`)
          }
        } else {
          console.log(JSON.stringify(values, null, 2))
        }
      }
    })
}
