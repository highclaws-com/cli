import { Command } from "commander"
import { LoadedConfig } from "../../config"

export function registerSwarm(admin: Command, getCtx: () => LoadedConfig): void {
  admin
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
}
