import path from "node:path"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { run } from "../../exec"

interface BackupOptions {
  all?: boolean
  ca?: boolean
  db?: boolean
  localSecrets?: boolean
  retentionDays: string
}

export function registerBackup(admin: Command, getCtx: () => LoadedConfig): void {
  const backup = admin
    .command("backup")
    .description("backup helpers")
    .option("--all", "back up the CA, database, and local secrets")
    .option("--ca", "back up the step CA volume from the manager swarm node")
    .option("--db", "back up the full PostgreSQL database")
    .option("--local-secrets", "back up the local secrets directory")
    .option("--retention-days <days>", "retention days for local backup files", "7")
    .action(async (opts: BackupOptions) => {
      if (!opts.all && !opts.ca && !opts.db && !opts.localSecrets) {
        backup.outputHelp()
        return
      }
      if (!/^\d+$/.test(opts.retentionDays) || !Number.isSafeInteger(Number(opts.retentionDays))) {
        throw new Error("retention days must be a non-negative integer")
      }
      const { root, config } = getCtx()
      const backupCa = opts.all || opts.ca
      const backupDb = opts.all || opts.db
      const backupLocalSecrets = opts.all || opts.localSecrets

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
        const manager = (config.swarm ?? []).find((n) => n.manager)
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
        const target = config.db
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
