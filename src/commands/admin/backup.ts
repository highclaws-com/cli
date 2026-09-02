import path from "node:path"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { run } from "../../exec"

interface BackupOptions {
  ca?: boolean
  localSecrets?: boolean
  retentionDays: string
}

export function registerBackup(admin: Command, getCtx: () => LoadedConfig): void {
  const backup = admin
    .command("backup")
    .description("backup helpers")
    .option("--ca", "back up the step CA volume from the manager swarm node")
    .option("--local-secrets", "back up the local secrets directory")
    .option("--retention-days <days>", "retention days for local backup files", "7")
    .action(async (opts: BackupOptions) => {
      if (!opts.ca && !opts.localSecrets) {
        backup.outputHelp()
        return
      }
      if (!/^\d+$/.test(opts.retentionDays) || !Number.isSafeInteger(Number(opts.retentionDays))) {
        throw new Error("retention days must be a non-negative integer")
      }
      const { root, config } = getCtx()

      if (opts.localSecrets) {
        console.log("[local-secrets] backing up local secrets directory")
        const rc = await run("./scripts/local_secrets_bkup.sh", [root, opts.retentionDays], {
          cwd: root
        })
        if (rc !== 0) {
          throw new Error(`local secrets backup failed (exit ${rc})`)
        }
      }

      if (opts.ca) {
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
    })
}
