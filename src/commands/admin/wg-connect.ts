import path from "node:path"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { escapeShell, run } from "../../exec"

export function registerWgConnect(admin: Command, getCtx: () => LoadedConfig): void {
  const wgConnect = admin
    .command("wg-connect")
    .description("establish WireGuard connections between deployment nodes")

  wgConnect
    .command("db-swarm")
    .description("connect the db WireGuard client to the swarm manager")
    .action(async () => {
      const { root, config } = getCtx()
      const db = config.db
      if (!db) {
        throw new Error("no 'db' entry in secrets/cli.json")
      }
      const manager = (config.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }

      const managerDocker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const connectArgs = [
        manager.ssh_usr,
        manager.ip,
        "g-wireguard-server-1",
        "db_1-wireguard_client-1",
        `ssh -i ${manager.ssh_key}`,
        managerDocker
      ]
      const dbKey = path.join(root, db.ssh_key)
      const repoDir = path.basename(root)
      const managerSsh = `ssh -i ${manager.ssh_key}`
      const remoteCommand = [
        `cd ${escapeShell(repoDir)}`,
        `./app/wg_customized/connect.sh ${connectArgs.map(escapeShell).join(" ")}`,
        `printf ${escapeShell("\n========== DB WireGuard: db_1-wireguard_client-1 ==========\n")}`,
        `docker exec db_1-wireguard_client-1 wg show`,
        `printf ${escapeShell("\n========== Swarm WireGuard: g-wireguard-server-1 ==========\n")}`,
        `${managerSsh} ${manager.ssh_usr}@${manager.ip} ${escapeShell(`${managerDocker} exec g-wireguard-server-1 wg show`)}`
      ].join(" && ")

      console.log(`connecting db ${db.ip} to swarm manager ${manager.ip}`)
      console.log(`$ ssh -i ${dbKey} ${db.ssh_usr}@${db.ip} -- ${remoteCommand}`)
      const rc = await run("ssh", ["-i", dbKey, `${db.ssh_usr}@${db.ip}`, "--", remoteCommand])
      if (rc !== 0) {
        throw new Error(`db-swarm WireGuard connection failed (exit ${rc})`)
      }
    })
}
