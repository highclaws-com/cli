import fs from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { Command } from "commander"
import { LoadedConfig } from "../../config"
import { run } from "../../exec"

interface DeployOptions {
  portainer?: boolean
  stack?: boolean
  secrets?: boolean
  updateFirewall?: boolean
  pveImage?: boolean
}

export function registerDeploy(admin: Command, getCtx: () => LoadedConfig): void {
  const deploy = admin
    .command("deploy")
    .description("deployment helpers")
    .option("--secrets", "upload local secrets to the manager swarm node and the db node")
    .option("--stack", "update and deploy the swarm-1 stack on the manager swarm node")
    .option("--portainer", "deploy portainer on the manager swarm node and open the local tunnel")
    .option("--update-firewall", "apply the firewall to all swarm nodes")
    .option("--pve-image", "print and, after confirmation, run the pve_template_roll.sh commands for the saved base image")
    .action(async (opts: DeployOptions) => {
      if (!opts.portainer && !opts.stack && !opts.secrets && !opts.updateFirewall && !opts.pveImage) {
        deploy.outputHelp()
        return
      }
      const { root, config } = getCtx()
      const manager = (config.swarm ?? []).find((n) => n.manager)
      if (!manager) {
        throw new Error("no swarm node with manager=true in secrets/cli.json")
      }
      const key = path.join(root, manager.ssh_key)
      const at = `${manager.ssh_usr}@${manager.ip}`
      const docker = manager.ssh_usr === "root" ? "docker" : "sudo docker"

      if (opts.secrets) {
        if (!config.db) {
          throw new Error("no 'db' entry in secrets/cli.json")
        }
        if (!fs.existsSync(path.join(root, "secrets", "config.env"))) {
          throw new Error(`missing ${path.join(root, "secrets", "config.env")}; refusing to upload an incomplete secrets bundle`)
        }
        for (const [i, n] of (config.pve ?? []).entries()) {
          console.log(`[secrets] pve ${i + 1}: saving secrets from ${n.ip} as ${n.ssh_usr}`)
          const rc = await run(
            "./scripts/pve_save_secrets.sh",
            [n.ssh_usr, n.ip],
            { cwd: root, env: { PVE_KEY: path.join(root, n.ssh_key) } }
          )
          if (rc !== 0) {
            throw new Error(`pve save secrets failed for ${n.ip} (exit ${rc})`)
          }
        }
        const targets = [
          { name: `swarm manager ${manager.ip}`, node: manager },
          { name: `db ${config.db.ip}`, node: config.db }
        ]
        for (const { name, node } of targets) {
          console.log(`[secrets] uploading to ${name}`)
          const rc = await run(
            "./scripts/scp_secrets.sh",
            [node.ip, path.join(root, node.ssh_key), node.ssh_usr, node.ssh_usr === "root" ? "" : "sudo"],
            { cwd: root }
          )
          if (rc !== 0) {
            throw new Error(`secrets upload failed for ${name} (exit ${rc})`)
          }
        }
      }

      if (opts.stack) {
        if (!manager.src_path) {
          throw new Error("no src_path on the manager swarm node in secrets/cli.json")
        }
        const stackCmd = [
          "git fetch --depth=1 origin deploy",
          "git checkout -B deploy origin/deploy",
          "git submodule update --init --recursive --recommend-shallow",
          "source config.env",
          "docker stack deploy --prune --compose-file swarm_service.yml swarm-1 --detach=false --with-registry-auth"
        ].join(" && ")
        const shell = manager.ssh_usr === "root" ? "bash" : "sudo bash"
        const remoteCmd = `${shell} -c 'cd ${manager.src_path} && ${stackCmd}'`
        console.log(`deploying swarm-1 stack on manager ${manager.ip}`)
        console.log(`$ ssh -i ${key} ${at} -- ${remoteCmd}`)
        const rc = await run("ssh", ["-i", key, at, "--", remoteCmd])
        if (rc !== 0) {
          throw new Error(`stack deploy failed (exit ${rc})`)
        }
      }

      if (opts.portainer) {
        if (!manager.src_path) {
          throw new Error("no src_path on the manager swarm node in secrets/cli.json")
        }
        const remoteCmd = `cd ${manager.src_path} && ${docker} compose -f portainer.yml up --detach --remove-orphans`
        console.log(`[1/2] deploying portainer on manager ${manager.ip}`)
        console.log(`$ ssh -i ${key} ${at} -- ${remoteCmd}`)
        const rc = await run("ssh", ["-i", key, at, "--", remoteCmd])
        if (rc !== 0) {
          throw new Error(`deploy failed (exit ${rc})`)
        }

        console.log(`\n\x1b[1;32m 🚀 visit: https://127.0.0.1:9443/ \x1b[0m`)
        console.log(`[2/2] tunneling 127.0.0.1:9443 to manager ${manager.ip}; keep this session running, ctrl+c to stop`)
        const tunnelArgs = ["-i", key, "-N", "-L", "9443:127.0.0.1:9443", at]
        console.log(`$ ssh -i ${key} -N -L 9443:127.0.0.1:9443 ${at}`)
        const tc = await run("ssh", tunnelArgs)
        if (tc !== 0) {
          throw new Error(`tunnel ended (exit ${tc})`)
        }
      }

      if (opts.pveImage) {
        const img = config.pve_base_image
        const targets = config.pve ?? []
        if (targets.length === 0) {
          throw new Error("no 'pve' entries in secrets/cli.json")
        }
        if (!img?.url_prefix || !img.url_path || !img.url_img) {
          throw new Error("no pve_base_image saved")
        }
        const url = `${img.url_prefix}/${img.url_path}/${img.url_img}`
        targets.forEach((n, i) => {
          console.log(`\x1b[1;32m [${i + 1}] ./scripts/pve_template_roll.sh ${n.ip} ${url} \x1b[0m`)
        })
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        let answer
        try {
          const plural = targets.length > 1 ? "s" : ""
          answer = (await rl.question(`run ${targets.length} command${plural}? (y/N) `)).trim().toLowerCase()
        } catch {
          throw new Error("input closed, nothing ran")
        } finally {
          rl.close()
        }
        if (answer !== "y" && answer !== "yes") {
          console.log("skipped, nothing ran")
          return
        }
        for (const [i, n] of targets.entries()) {
          console.log(`[pve-image ${i + 1}] rolling template on ${n.ip}`)
          const rc = await run(
            "./scripts/pve_template_roll.sh",
            [n.ip, url],
            { cwd: root, env: { PVE_KEY: path.join(root, n.ssh_key) } }
          )
          if (rc !== 0) {
            throw new Error(`pve template roll failed for ${n.ip} (exit ${rc})`)
          }
        }
      }

      if (opts.updateFirewall) {
        const swarm = config.swarm ?? []
        if (swarm.length === 0) {
          throw new Error("no 'swarm' entries in secrets/cli.json")
        }
        for (const n of swarm) {
          console.log(`[firewall] applying on ${n.ip} as ${n.ssh_usr}`)
          const rc = await run(
            "./scripts/pve_firewall.sh",
            [n.ssh_usr, n.ip],
            { cwd: root, env: { PVE_KEY: path.join(root, n.ssh_key) } }
          )
          if (rc !== 0) {
            throw new Error(`firewall failed for ${n.ip} (exit ${rc})`)
          }
        }
      }
    })
}
