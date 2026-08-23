import path from "node:path"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { run } from "../../exec"

export function registerSwarm(admin: Command, getCtx: () => LoadedConfig): void {
  const swarmCommand = admin
    .command("swarm")
    .description("list swarm nodes")
    .action(async () => {
      const { config } = getCtx()
      const swarm = config.swarm ?? []
      if (swarm.length === 0) {
        throw new Error("no 'swarm' entries in secrets/cli.json")
      }
      swarm.forEach((n, i) => {
        console.log(`\x1b[1;32m [${i + 1}] ssh -i ${n.ssh_key} ${n.ssh_usr}@${n.ip}${n.manager ? " (manager)" : ""} \x1b[0m`)
      })
    })

  const prune = swarmCommand
    .command("prune")
    .description("remove unused Docker resources from all swarm nodes")
    .option("--containers", "remove stopped containers")
    .option("--images", "remove unused images")
    .action(async (opts: { containers?: boolean; images?: boolean }) => {
      if (!opts.containers && !opts.images) {
        prune.outputHelp()
        return
      }

      const { root, config } = getCtx()
      for (const node of config.swarm ?? []) {
        const docker = node.ssh_usr === "root" ? "docker" : "sudo docker"
        const commands = []
        if (opts.containers) commands.push(`${docker} container prune -f`)
        if (opts.images) commands.push(`${docker} image prune -a -f`)

        console.log(`[${node.ip}] $ ${commands.join(" && ")}`)
        const rc = await run("ssh", [
          "-i",
          path.join(root, node.ssh_key),
          `${node.ssh_usr}@${node.ip}`,
          commands.join(" && ")
        ])
        if (rc !== 0) {
          throw new Error(`swarm prune failed on ${node.ip} (exit ${rc})`)
        }
      }
    })
}
