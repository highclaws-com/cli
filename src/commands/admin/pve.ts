import path from "node:path"
import readline from "node:readline/promises"
import { Command } from "commander"
import { LoadedConfig, saveConfig } from "../../config"
import { escapeShell, run, runCapture } from "../../exec"

interface PveOptions {
  proxmox?: boolean
  updateFirewall?: boolean
  baseImages?: boolean
  removeNodeVm?: string
}

const DEFAULT_URL_PREFIX = "https://cloud.debian.org/images/cloud"

const isLocal = (h: string): boolean => !h.startsWith("/") && !h.includes("//")

function pickHrefs(html: string, ok: (h: string) => boolean): string[] {
  return [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter(ok))].sort()
}

async function listNames(url: string, ok: (h: string) => boolean): Promise<string[]> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`listing ${url} failed (HTTP ${res.status})`)
  }
  return pickHrefs(await res.text(), (h) => isLocal(h) && ok(h))
}

async function select(
  rl: readline.Interface,
  step: number,
  total: number,
  label: string,
  options: string[]
): Promise<string> {
  if (options.length === 0) {
    throw new Error(`no options listed for ${label}`)
  }
  console.log(`\n[${step}/${total}] select ${label}:`)
  options.forEach((o, i) => console.log(`  [${i + 1}] ${o}`))
  for (;;) {
    let answer
    try {
      answer = (await rl.question("> ")).trim()
    } catch {
      throw new Error("aborted, nothing saved")
    }
    if (answer === "") {
      throw new Error("aborted, nothing saved")
    }
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1]
    }
    console.log("invalid choice, try again")
  }
}

async function baseImages(ctx: () => LoadedConfig): Promise<void> {
  const { root, config } = ctx()
  const prev = config.pve_base_image ?? {}
  console.log("current values in secrets/cli.json:")
  console.log(`  url_prefix : ${prev.url_prefix ?? "empty"}`)
  console.log(`  url_path   : ${prev.url_path ?? "empty"}`)
  console.log(`  url_img    : ${prev.url_img ?? "empty"}`)
  const prefix = (prev.url_prefix ?? DEFAULT_URL_PREFIX).replace(/\/+$/, "")
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const distro = await select(
      rl, 1, 3, "distribution",
      (await listNames(`${prefix}/`, (h) => h.endsWith("/"))).map((h) => h.slice(0, -1))
    )
    const build = await select(
      rl, 2, 3, `build of ${distro}`,
      (await listNames(`${prefix}/${distro}/`, (h) => h.endsWith("/"))).map((h) => h.slice(0, -1))
    )
    const img = await select(
      rl, 3, 3, `image of ${distro}/${build}`,
      await listNames(`${prefix}/${distro}/${build}/`, (h) => h.endsWith(".qcow2"))
    )
    config.pve_base_image = { url_prefix: prefix, url_path: `${distro}/${build}`, url_img: img }
    saveConfig(root, config)
    console.log("saved to secrets/cli.json")
  } finally {
    rl.close()
  }
}

export function registerPve(admin: Command, getCtx: () => LoadedConfig): void {
  const pve = admin
    .command("pve")
    .description("pve helpers")
    .option("--proxmox", "show the proxmox web endpoints")
    .option("--update-firewall", "apply the pve firewall whitelisting all swarm nodes")
    .option("--base-images", "interactively pick the debian base image and save it to cli.json")
    .option("--remove-node-vm <node_id>", "destroy the VM matching a sandbox node_id")
    .action(async (opts: PveOptions) => {
      if (!opts.proxmox && !opts.updateFirewall && !opts.baseImages && !opts.removeNodeVm) {
        pve.outputHelp()
        return
      }
      const { root, config } = getCtx()
      if (!config.pve || config.pve.length === 0) {
        throw new Error("no 'pve' entries in secrets/cli.json")
      }

      if (opts.baseImages) {
        await baseImages(getCtx)
        return
      }

      if (opts.removeNodeVm) {
        const name = `selfhost-${opts.removeNodeVm}`
        for (const target of config.pve) {
          const key = path.join(root, target.ssh_key)
          const at = `${target.ssh_usr}@${target.ip}`
          const lookupCommand = `qm list | awk -v name=${escapeShell(name)}` +
            ` '$2 == name {print $1}'`
          const lookup = await runCapture("ssh", ["-i", key, at, lookupCommand])
          if (lookup.code !== 0) throw new Error(`VM lookup failed on ${target.ip}`)
          const vmid = lookup.stdout.trim()
          if (!vmid) continue
          console.log(`${vmid} (${name}) on ${target.ip}`)
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
          const answer = (await rl.question("destroy this VM? (y/N) ")).trim().toLowerCase()
          rl.close()
          if (answer !== "y" && answer !== "yes") {
            console.log("skipped, nothing removed")
            return
          }
          const command = `set -e; if qm status ${vmid} | grep -q 'status: running';` +
            ` then qm stop ${vmid}; qm wait ${vmid}; fi;` +
            ` qm destroy ${vmid} --destroy-unreferenced-disks 1 --purge 1`
          const rc = await run("ssh", ["-i", key, at, command])
          if (rc !== 0) throw new Error(`VM removal failed on ${target.ip} (exit ${rc})`)
          return
        }
        throw new Error(`no PVE VM found with name ${name}`)
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
