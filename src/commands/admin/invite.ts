import path from "node:path"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { escapeShell, run, runCapture } from "../../exec"

interface GenerateOptions {
  max_uses: string
  expiry_hours: string
  trial_hours_addition: string
  model_quota_dollars_addition: string
}

export function registerInvite(admin: Command, getCtx: () => LoadedConfig): void {
  const invite = admin.command("invite").description("manage invite codes")

  invite
    .command("generate")
    .description("generate an invite code through the swarm manager")
    .option("--max_uses <count>", "maximum number of redemptions", "1")
    .option("--expiry_hours <hours>", "hours until expiration; 0 disables expiry", "42")
    .option("--trial_hours_addition <hours>", "trial hours granted on redemption", "48")
    .option(
      "--model_quota_dollars_addition <amount>",
      "model usage quota granted on redemption, in dollars",
      "0"
    )
    .action(async (opts: GenerateOptions) => {
      const { root, config } = getCtx()
      const manager = (config.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }

      const payload = JSON.stringify({
        max_uses: Number(opts.max_uses),
        expiry_hours: Number(opts.expiry_hours),
        trial_hours_addition: Number(opts.trial_hours_addition),
        model_quota_dollars_addition: Number(opts.model_quota_dollars_addition)
      })
      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const remote = `${docker} exec $(${docker} ps -q --filter 'name=admission[^_]' | head -n 1) curl -fsS -X POST http://localhost:8000/api/v1/code/generate -H 'X-User-Uid: 1' -H 'Content-Type: application/json' -d ${escapeShell(payload)}`
      const key = path.join(root, manager.ssh_key)
      const at = `${manager.ssh_usr}@${manager.ip}`

      const rc = await run("ssh", ["-i", key, at, remote])
      if (rc !== 0) {
        throw new Error(`invite code generation failed (exit ${rc})`)
      }
    })

  invite
    .command("validate")
    .description("get invite code information through the swarm manager")
    .argument("<code>", "invite code")
    .action(async (code: string) => {
      const { root, config } = getCtx()
      const manager = (config.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }

      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const remote = `${docker} exec $(${docker} ps -q --filter 'name=admission[^_]' | head -n 1) curl -fsS http://localhost:8000/api/v1/code/validate/${escapeShell(code)} -H 'X-User-Uid: 1'`
      const key = path.join(root, manager.ssh_key)
      const at = `${manager.ssh_usr}@${manager.ip}`

      const { code: rc, stdout } = await runCapture("ssh", ["-i", key, at, remote])
      if (rc !== 0) {
        throw new Error(`invite code validation failed (exit ${rc})`)
      }
      console.log(JSON.stringify(JSON.parse(stdout), null, 2))
    })
}
