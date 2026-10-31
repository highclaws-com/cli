import path from "node:path"
import { Command } from "commander"
import { AdminContext } from "../../config"
import { escapeShell, run, runCapture, SSH_OPTS } from "../../exec"
import { registerDeploy } from "./deploy"
import { registerPve } from "./pve"

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
    .command("post-updates")
    .description("update firewalls, secrets, checkout, and bind-mount services for configured nodes")
    .action(async () => {
      const commands = [
        ["pve", "--update-firewall"],
        ["deploy", "--secrets"],
        ["deploy", "--checkout"],
        ["deploy", "--bind-mount-services"],
        ["deploy", "--update-firewall"]
      ]
      for (const args of commands) {
        console.log(`hc admin ${args.join(" ")}`)
        const command = new Command()
        registerPve(command, getCtx)
        registerDeploy(command, getCtx)
        await command.parseAsync(args, { from: "user" })
      }
    })

  swarmCommand
    .command("fetch-node-info")
    .description("fetch the NodeID, memory, and disk usage of each configured swarm node over SSH")
    .action(async () => {
      const { root, adminConfig } = getCtx()
      const swarm = adminConfig.swarm ?? []
      if (swarm.length === 0) {
        throw new Error("no 'swarm' entries in secrets/cli.json")
      }
      for (const n of swarm) {
        const docker = n.ssh_usr === "root" ? "docker" : "sudo docker"
        const remoteCmd =
          `node_id=$(${docker} info --format '{{.Swarm.NodeID}}') && ` +
          `mem=$(free -h | awk '/^Mem:/ {print $3 "/" $2 " (remain " $7 ")"}') && ` +
          `disk=$(df -h -P / | awk 'NR==2 {print $3 "/" $2 " (remain " $4 ")"}') && ` +
          `echo "$node_id | mem: $mem | disk: $disk"`
        const { code, stdout } = await runCapture("ssh", [
          ...SSH_OPTS,
          "-i",
          path.join(root, n.ssh_key),
          `${n.ssh_usr}@${n.ip}`,
          remoteCmd
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
      // `node ls` cannot show labels, so read the same columns plus labels
      // from `node inspect`, one tab-separated line per node.
      const format = [
        "{{.ID}}",
        "{{.Description.Hostname}}",
        "{{.Status.State}}",
        "{{.Spec.Availability}}",
        "{{with .ManagerStatus}}{{if .Leader}}leader{{else}}{{.Reachability}}{{end}}{{end}}",
        "{{.Description.Engine.EngineVersion}}",
        "{{range $k, $v := .Spec.Labels}}{{$k}}={{$v}} {{end}}"
      ].join("\t")
      const { code, stdout } = await runCapture("ssh", [
        ...SSH_OPTS,
        "-i",
        path.join(root, manager.ssh_key),
        `${manager.ssh_usr}@${manager.ip}`,
        `${docker} node inspect --format ${escapeShell(format)} $(${docker} node ls -q)`
      ])
      if (code !== 0) {
        throw new Error(`swarm list-nodes failed (exit ${code})`)
      }
      const rows = [
        ["ID", "HOSTNAME", "STATUS", "AVAILABILITY", "MANAGER STATUS", "ENGINE VERSION", "LABELS"],
        ...stdout.split("\n").filter((line) => line).map((line) => line.split("\t"))
      ]
      const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)) + 3)
      for (const row of rows) {
        console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("").trimEnd())
      }
    })

  swarmCommand
    .command("prune-nodes")
    .description("remove all down nodes from the swarm cluster")
    .action(async () => {
      const { root, adminConfig } = getCtx()
      const manager = (adminConfig.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }
      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const remoteCmd = `${docker} node ls --format '{{.ID}} {{.Status}}' | awk '$2 == "Down" {print $1}' | xargs -r ${docker} node rm`
      console.log(`[${manager.ip}] $ ${remoteCmd}`)
      const rc = await run("ssh", [
        ...SSH_OPTS,
        "-i",
        path.join(root, manager.ssh_key),
        `${manager.ssh_usr}@${manager.ip}`,
        remoteCmd
      ])
      if (rc !== 0) {
        throw new Error(`swarm prune-nodes failed (exit ${rc})`)
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
        ...SSH_OPTS,
        "-i",
        path.join(root, manager.ssh_key),
        `${manager.ssh_usr}@${manager.ip}`,
        `${docker} stack ps swarm-1 --filter desired-state=running`
      ])
      if (rc !== 0) {
        throw new Error(`swarm list-stack failed (exit ${rc})`)
      }
    })

  swarmCommand
    .command("print-service <service>")
    .description("print service tasks, nodes, states, and endpoint mode")
    .action(async (service: string) => {
      const { root, adminConfig } = getCtx()
      const manager = (adminConfig.swarm ?? []).find((node) => node.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }
      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
      const rc = await run("ssh", [
        ...SSH_OPTS,
        "-i",
        path.join(root, manager.ssh_key),
        `${manager.ssh_usr}@${manager.ip}`,
        `mode=$(${docker} service inspect ${escapeShell(service)} --format '{{.Endpoint.Spec.Mode}}') && ` +
          `${docker} service ps ${escapeShell(service)} --filter desired-state=running ` +
          `--format "table {{.Name}}\\t{{.Node}}\\t{{.DesiredState}}\\t{{.CurrentState}}\\t$mode"`
      ])
      if (rc !== 0) {
        throw new Error(`swarm print-service failed (exit ${rc})`)
      }
    })

  // e.g. `label-node <node> model_oauth=1` and `unlabel-node <node> model_oauth`
  for (const [name, flag, description] of [
    ["label-node", "--label-add", "add a label to a node (ID or HOSTNAME from list-nodes), e.g. model_oauth=1"],
    ["unlabel-node", "--label-rm", "remove a label from a node by its key, e.g. model_oauth"]
  ]) {
    swarmCommand
      .command(`${name} <node> <label>`)
      .description(description)
      .action(async (node: string, label: string) => {
        const { root, adminConfig } = getCtx()
        const manager = (adminConfig.swarm ?? []).find((n) => n.manager)
        if (!manager) {
          throw new Error("no swarm node with manager=true in secrets/cli.json")
        }
        const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"
        const rc = await run("ssh", [
          ...SSH_OPTS,
          "-i",
          path.join(root, manager.ssh_key),
          `${manager.ssh_usr}@${manager.ip}`,
          `${docker} node update ${flag} ${escapeShell(label)} ${escapeShell(node)}`
        ])
        if (rc !== 0) {
          throw new Error(`swarm ${name} failed (exit ${rc})`)
        }
      })
  }

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
          ...SSH_OPTS,
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
          ...SSH_OPTS,
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
