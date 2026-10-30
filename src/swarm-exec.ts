import path from "node:path"
import { AdminContext, SshTarget } from "./config"
import { runCapture, SSH_OPTS } from "./exec"

function ssh(root: string, node: SshTarget, command: string) {
  return runCapture("ssh", [
    ...SSH_OPTS,
    "-i", path.join(root, node.ssh_key), `${node.ssh_usr}@${node.ip}`, command
  ])
}

// Runs `command` inside a running container of the swarm-1 `service` on
// whichever node Swarm placed it, e.g. ("billing", "cat /app/x.json") ->
// `docker exec <container id> cat /app/x.json` on worker 1.2.3.7.
export async function swarmExec(
  { root, adminConfig }: AdminContext,
  service: string,
  command: string
): Promise<{ code: number; stdout: string }> {
  const swarm = adminConfig.swarm ?? []
  const docker = (node: SshTarget) => node.ssh_usr === "root" ? "docker" : "sudo docker"
  const manager = swarm.find((node) => node.manager)
  if (!manager) {
    throw new Error("no swarm node with manager=true in secrets/cli.json")
  }
  // Placement of one running task, e.g. "k3x9... 7ef218a931cb...".
  const task = await ssh(root, manager,
    `${docker(manager)} inspect --format '{{.NodeID}} {{.Status.ContainerStatus.ContainerID}}'` +
      ` $(${docker(manager)} service ps -q --filter desired-state=running swarm-1_${service} | head -n 1)`
  )
  if (task.code !== 0) {
    throw new Error(`no running ${service} task found (exit ${task.code})`)
  }
  const [nodeId, containerId] = task.stdout.trim().split(" ")
  // Swarm node ID of each configured node, in adminConfig.swarm order.
  const ids = await Promise.all(
    swarm.map((node) => ssh(root, node, `${docker(node)} info --format '{{.Swarm.NodeID}}'`))
  )
  const node = swarm.find((_, i) => ids[i].stdout.trim() === nodeId)
  if (!node) {
    throw new Error(`swarm node ${nodeId} running ${service} is not in secrets/cli.json`)
  }
  return ssh(root, node, `${docker(node)} exec ${containerId} ${command}`)
}
