import fs from "node:fs"
import path from "node:path"
import { Command } from "commander"
import { AdminContext, extractEnv } from "../../config"
import { run } from "../../exec"

interface BackupOptions {
  all?: boolean
  ca?: boolean
  db?: boolean
  localSecrets?: boolean
  modelPool?: boolean
  retentionDays: string
}

export function registerBackup(admin: Command, getCtx: () => AdminContext): void {
  const backup = admin
    .command("backup")
    .description("backup helpers")
    .option("--all", "back up the model pool config, local secrets, CA, and database")
    .option("--ca", "back up the step CA volume from the manager swarm node")
    .option("--db", "back up the full PostgreSQL database")
    .option("--local-secrets", "back up the local secrets directory")
    .option("--model-pool", "download the model pool config into secrets/model-pool.yml")
    .option("--retention-days <days>", "retention days for local backup files", "7")
    .action(async (opts: BackupOptions) => {
      if (!opts.all && !opts.ca && !opts.db && !opts.localSecrets && !opts.modelPool) {
        backup.outputHelp()
        return
      }
      if (!/^\d+$/.test(opts.retentionDays) || !Number.isSafeInteger(Number(opts.retentionDays))) {
        throw new Error("retention days must be a non-negative integer")
      }
      const { root, adminConfig, env } = getCtx()
      const backupModelPool = opts.all || opts.modelPool
      const backupLocalSecrets = opts.all || opts.localSecrets
      const backupCa = opts.all || opts.ca
      const backupDb = opts.all || opts.db

      if (backupModelPool) {
        if (!adminConfig.domain) {
          throw new Error("no 'domain' key in secrets/cli.json")
        }
        const [managementKey] = extractEnv(env, ["GATEWAY_VIEWER_KEY"])
        const url = `https://model-pool.${adminConfig.domain}/v0/management/config.yaml`
        console.log(`[model-pool] downloading config from ${url}`)
        const res = await fetch(url, {
          headers: { "X-Management-Key": managementKey }
        })
        if (!res.ok) {
          throw new Error(`model pool backup failed: HTTP ${res.status} ${res.statusText}`)
        }
        const dest = path.join(root, "secrets", "model-pool.yml")
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, await res.text(), { mode: 0o600 })
        console.log(`Model pool config saved to ${dest}`)
      }

      if (backupLocalSecrets) {
        console.log("[local-secrets] backing up local secrets directory")
        const rc = await run("./scripts/local_secrets_bkup.sh", [root, opts.retentionDays], {
          cwd: root
        })
        if (rc !== 0) {
          throw new Error(`local secrets backup failed (exit ${rc})`)
        }
      }

      if (backupCa) {
        const manager = (adminConfig.swarm ?? []).find((n) => n.manager)
        if (!manager) {
          throw new Error("no swarm node with manager=true in secrets/cli.json")
        }
        const args = [
          manager.ip,
          opts.retentionDays,
          path.join(root, manager.ssh_key),
          manager.ssh_usr === "root" ? "" : "sudo",
          "swarm-1_step_data",
          manager.ssh_usr
        ]
        console.log(`[ca] backing up step CA from manager ${manager.ip}`)
        const rc = await run("./scripts/ca_bkup.sh", args, { cwd: root })
        if (rc !== 0) {
          throw new Error(`ca backup failed (exit ${rc})`)
        }
      }

      if (backupDb) {
        const target = adminConfig.db
        if (!target) {
          throw new Error("no 'db' entry in secrets/cli.json")
        }
        const args = [
          target.ip,
          opts.retentionDays,
          path.join(root, target.ssh_key),
          target.ssh_usr === "root" ? "" : "sudo",
          target.ssh_usr
        ]
        console.log(`[db] backing up PostgreSQL from ${target.ip}`)
        const rc = await run("./scripts/db_bkup.sh", args, { cwd: root })
        if (rc !== 0) {
          throw new Error(`database backup failed (exit ${rc})`)
        }
      }
    })
}
