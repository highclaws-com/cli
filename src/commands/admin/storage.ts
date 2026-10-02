import { Command } from "commander"
import { AdminContext, extractEnv } from "../../config"
import { run } from "../../exec"

interface StorageOptions {
  resetAllSubs?: boolean
}

export function registerStorage(admin: Command, getCtx: () => AdminContext): void {
  const storage = admin
    .command("storage")
    .description("S3 storage quota maintenance")
    .option(
      "--reset-all-subs",
      "reset storage usage of all users by deleting every period stats file"
    )
    .action(async (opts: StorageOptions) => {
      if (!opts.resetAllSubs) {
        storage.outputHelp()
        return
      }

      const { env } = getCtx()
      const [accessKeyId, secretAccessKey, endpoint] = extractEnv(env, [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "JFS_S3_ENDPOINT"
      ])

      // Delete only usage stats, e.g. sandbox-usage/user5/sub-1_...-stats.json
      // and its -stats.lock; keep user5/quota.json, which billing republishes
      // only on subscription changes and without which backups are skipped.
      // Keys are passed by name (-e KEY) so they stay out of the process list.
      const rc = await run(
        "docker",
        [
          "run", "--rm",
          "-e", "AWS_DEFAULT_REGION=auto",
          "-e", "AWS_ACCESS_KEY_ID",
          "-e", "AWS_SECRET_ACCESS_KEY",
          "amazon/aws-cli",
          "s3", "rm", "s3://sandbox-usage/",
          "--recursive",
          "--endpoint-url", endpoint,
          "--exclude", "*",
          "--include", "*-stats.json",
          "--include", "*-stats.lock"
        ],
        {
          env: {
            AWS_ACCESS_KEY_ID: accessKeyId,
            AWS_SECRET_ACCESS_KEY: secretAccessKey
          }
        }
      )
      if (rc !== 0) {
        throw new Error(`storage stats reset failed (exit ${rc})`)
      }
    })
}
