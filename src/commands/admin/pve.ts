import path from "node:path"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { run } from "../../exec"

interface PveOptions {
  proxmox?: boolean
  updateFirewall?: boolean
}

export function registerPve(admin: Command, getCtx: () => LoadedConfig): void {
  const pve = admin
    .command("pve")
    .description("pve helpers")
    .option("--proxmox", "show the proxmox web endpoints")
    .option("--update-firewall", "apply the pve firewall whitelisting all swarm nodes")
    .action(async (opts: PveOptions) => {
      if (!opts.proxmox && !opts.updateFirewall) {
        pve.outputHelp()
        return
      }
      const { root, config } = getCtx()
      if (!config.pve || config.pve.length === 0) {
        throw new Error("no 'pve' entries in secrets/cli.json")
      }

      if (opts.proxmox) {
        config.pve.forEach((n, i) => {
          console.log(`[${i + 1}] https://${n.ip}:${n.web_port}/ (user: ${n.ssh_usr}, pass: ${n.web_pass})`)
        })
      }

      if (opts.updateFirewall) {
        const swarmIps = (config.swarm ?? []).map((n) => n.ip)
        if (swarmIps.length === 0) {
          throw new Error("no 'swarm' entries in secrets/cli.json")
        }
        for (const [i, n] of config.pve.entries()) {
          console.log(`[pve ${i + 1}] applying firewall on ${n.ip}; whitelist: ${swarmIps.join(", ")}`)
          const rc = await run(
            "./scripts/pve_firewall.sh",
            [n.ssh_usr, n.ip, ...swarmIps],
            { cwd: root, env: { PVE_KEY: path.join(root, n.ssh_key) } }
          )
          if (rc !== 0) {
            throw new Error(`firewall failed for ${n.ip} (exit ${rc})`)
          }
        }
      }
    })
}
