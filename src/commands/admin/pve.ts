import { Command } from "commander"
import { LoadedConfig } from "../../config"

interface PveOptions {
  proxmox?: boolean
}

export function registerPve(admin: Command, getCtx: () => LoadedConfig): void {
  const pve = admin
    .command("pve")
    .description("pve helpers")
    .option("--proxmox", "show the proxmox web endpoints")
    .action((opts: PveOptions) => {
      if (!opts.proxmox) {
        pve.outputHelp()
        return
      }
      const { config } = getCtx()
      const nodes = config.pve
      if (!nodes || nodes.length === 0) {
        throw new Error("no 'pve' entries in secrets/cli.json")
      }
      nodes.forEach((n, i) => {
        console.log(`[${i + 1}] https://${n.ip}:${n.web_port}/ (user: ${n.ssh_usr}, pass: ${n.web_pass})`)
      })
    })
}
