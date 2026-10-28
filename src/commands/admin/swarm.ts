import path from "node:path"
import { Command } from "commander"
import { AdminContext } from "../../config"
import { run, runCapture } from "../../exec"

export function registerSwarm(admin: Command, getCtx: () => AdminContext): void {
  const swarmCommand = admin
    .command("swarm")
    .description("list swarm nodes")
    .action(async () => {
      const { adminConfig } = getCtx()
      const swarm = adminConfig.swarm ?? []
      if (swarm.length === 0) {
        throw new Error("no 'swarm' entries in secrets/cli.json")
      }
      swarm.forEach((n, i) => {
        console.log(`\x1b[1;32m [${i + 1}] ssh -i ${n.ssh_key} ${n.ssh_usr}@${n.ip}${n.manager ? " (manager)" : ""} \x1b[0m`)
      })
    })

  swarmCommand
    .command("fetch-node-id")
    .description("fetch the NodeID of each configured swarm node over SSH")
    .action(async () => {
      const { root, adminConfig } = getCtx()
      const swarm = adminConfig.swarm ?? []
      if (swarm.length === 0) {
        throw new Error("no 'swarm' entries in secrets/cli.json")
      }
      for (const n of swarm) {
        const docker = n.ssh_usr === "root" ? "docker" : "sudo docker"
        const { code, stdout } = await runCapture("ssh", [
          "-i",
          path.join(root, n.ssh_key),
          `${n.ssh_usr}@${n.ip}`,
          `${docker} info --format '{{.Swarm.NodeID}}'`
        ])
        if (code !== 0) {
          throw new Error(`swarm node lookup failed on ${n.ip} (exit ${code})`)
        }
        console.log(`${n.ip} ${stdout.trim()}`)
      }
    })

  swarmCommand
    .command("list-nodes")
    .description("list live swarm nodes from the first configured manager")
    .action(async () => {
      const { root, adminConfig } = getCtx()
      const manager = (adminConfig.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }
      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const rc = await run("ssh", [
        "-i",
        path.join(root, manager.ssh_key),
        `${manager.ssh_usr}@${manager.ip}`,
        `${docker} node ls`
      ])
      if (rc !== 0) {
        throw new Error(`swarm list-nodes failed (exit ${rc})`)
      }
    })

  swarmCommand
    .command("list-stack")
    .description("list swarm-1 service tasks and their nodes")
    .action(async () => {
      const { root, adminConfig } = getCtx()
      const manager = (adminConfig.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }
      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const rc = await run("ssh", [
        "-i",
        path.join(root, manager.ssh_key),
        `${manager.ssh_usr}@${manager.ip}`,
        `${docker} stack ps swarm-1 --filter desired-state=running`
      ])
      if (rc !== 0) {
        throw new Error(`swarm list-stack failed (exit ${rc})`)
      }
    })

  for (const role of ["worker", "manager"]) {
    swarmCommand
      .command(`${role}-join-info`)
      .description(`print the manager address and ${role} join token`)
      .action(async () => {
        const { root, adminConfig } = getCtx()
        const manager = (adminConfig.swarm ?? []).find((node) => node.manager)
        if (!manager) {
          throw new Error("no swarm node with manager=true in secrets/cli.json")
        }
        const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
        const rc = await run("ssh", [
          "-i",
          path.join(root, manager.ssh_key),
          `${manager.ssh_usr}@${manager.ip}`,
          `${docker} node inspect self --format '{{.ManagerStatus.Addr}}' | tr '\\n' ' '; ` +
            `${docker} swarm join-token ${role} -q`
        ])
        if (rc !== 0) {
          throw new Error(`swarm ${role}-join-info failed (exit ${rc})`)
        }
      })
  }

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

      const { root, adminConfig } = getCtx()
      for (const node of adminConfig.swarm ?? []) {
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
