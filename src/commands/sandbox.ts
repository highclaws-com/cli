import crypto from "node:crypto"
import fs from "node:fs"
import { Argument, Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiFetch, apiJson, apiRequest, hostBase } from "../api"
import {
  OutputOptions, byteSize, checkPage, confirm, output, pageNumber, printPage, printRows
} from "../output"
import { DEFAULT_PAGE_SIZE } from "./connector"

const PROVISION_API = `https://${APP_DOMAIN}/provision/api/v1`
const JOB_POLL_MS = 2000

// Fixed key the agent API requires in every sandbox. It is not a secret: the
// sandbox gateway's owner check on the login is what protects the agent.
const AGENT_API_KEY = "hermes-api-server-key"

// `hc sandbox bind <id> <kind>` -> the table in the binding route.
const BIND_TABLES: Record<string, string> = {
  ims: "connectors",
  vaults: "passwords"
}

const BIND_KINDS = ["agents", ...Object.keys(BIND_TABLES)]

interface AgentOptions extends OutputOptions {
  agent: string
}

// One status for the whole sandbox, from the statuses of its parts.
function sandboxStatus(row: any): string {
  // A sandbox without a gateway route has no ProvisionProxy record at all.
  const parts = [row.ProvisionBkt_status, row.ProvisionVPS_status]
  if (row.ProvisionProxy_rid !== null) parts.push(row.ProvisionProxy_status)
  if (row.status === "deleted" || row.status === "deleting") {
    return row.status
  } else if (parts.includes("failure")) {
    return "failure"
  } else if (parts.every((status) => status === "success")) {
    return "ready"
  } else {
    return "provisioning"
  }
}

function sandboxHost(row: any): string | undefined {
  const proxy = typeof row.ProvisionProxy_result === "string"
    ? JSON.parse(row.ProvisionProxy_result)
    : row.ProvisionProxy_result
  return proxy?.host
}

// The sandbox list row of one sandbox, which holds what only the list returns,
// e.g. its host.
async function findSandbox(id: string): Promise<any> {
  const sandboxes = await apiJson(`${PROVISION_API}/provisions?show_deleted=false&limit=100`)
  const row = sandboxes.items.find((row: any) => row.provision_id === id)
  if (!row) throw new Error(`no such sandbox: ${id}`)
  if (!sandboxHost(row)) throw new Error(`sandbox ${id} has no host yet`)
  return row
}

// Wait for a background job, printing each new progress message on stderr.
async function waitJob(jobId: string): Promise<void> {
  let progress = ""
  while (true) {
    const job = await apiJson(`${PROVISION_API}/job/${jobId}`)
    if (job.progress && String(job.progress) !== progress) {
      progress = String(job.progress)
      console.error(progress)
    }
    if (job.status === "finished") {
      return
    } else if (["failed", "stopped", "canceled"].includes(job.status)) {
      throw new Error(job.error_message ?? job.error_code ?? `job ${jobId} ${job.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS))
  }
}

// Print one job's current state, or follow it until it ends.
async function job(jobId: string, options: OutputOptions & { wait?: boolean }): Promise<void> {
  if (options.wait) await waitJob(jobId)
  const data = await apiJson(`${PROVISION_API}/job/${jobId}`)
  output(options, data, () => {
    printRows(
      ["JOB", "STATUS", "PROGRESS", "ERROR"],
      [[data.job_id, data.status, data.progress || undefined, data.error_message]]
    )
  })
}

// The sizes a sandbox can be created with.
async function tiers(options: OutputOptions): Promise<void> {
  const data = await apiJson(`https://${APP_DOMAIN}/provision/public/tiers`)
  output(options, data, () => {
    printRows(
      ["TIER", "UNITS", "VCPUS", "MEMORY-GIB"],
      data.map((tier: any) => [tier.tier, tier.units, tier.vcpus, tier.memory])
    )
  })
}

async function ls(
  options: OutputOptions & { limit: string; page: string; deleted?: boolean }
): Promise<void> {
  const limit = Number(options.limit)
  const page = pageNumber(options.page)
  // The provision API counts pages from 0.
  const data = await apiJson(
    `${PROVISION_API}/provisions` +
      `?show_deleted=${options.deleted ? "true" : "false"}&limit=${limit}&page=${page - 1}`
  )
  checkPage(page, limit, data.total_records)
  output(options, data, () => {
    printRows(
      ["ID", "NAME", "STATUS", "UNITS", "HOST", "CREATED"],
      data.items.map((row: any) => [
        row.provision_id,
        row.name,
        sandboxStatus(row),
        row.vps_unit,
        sandboxHost(row),
        row.init_timestamp
      ])
    )
    printPage(page, limit, data.total_records)
  })
}

async function create(
  tier: string,
  name: string,
  options: OutputOptions & {
    model?: string
    timezone?: string
    detach?: boolean
    recover?: string
    restoreAgents?: boolean
    restoreBrowser?: boolean
  }
): Promise<void> {
  if ((options.restoreAgents || options.restoreBrowser) && !options.recover) {
    throw new Error("--restore-agents and --restore-browser need --recover <id>")
  }
  const query = new URLSearchParams()
  if (options.timezone) query.set("timezone", options.timezone)
  if (options.recover) query.set("recover_storage", options.recover)
  const data = await apiJson(`${PROVISION_API}/job/${tier}/${name}?${query}`, "POST", {
    restore_agents: Boolean(options.restoreAgents),
    restore_browser: Boolean(options.restoreBrowser),
    init_agents: [{
      id: "default",
      display_name: null,
      model_rid: options.model ? Number(options.model) : null
    }]
  })
  if (options.detach) {
    output(options, data, () => {
      console.log(`creating ${data.provision_id} ${name}`)
      printRows(
        ["JOB", "PART"],
        [
          [data.bkt_job_id, "storage"],
          [data.vps_job_id, "machine"],
          [data.proxy_job_id, "gateway route"]
        ]
      )
    })
  } else {
    // Storage, then the machine, then its gateway route.
    await waitJob(data.bkt_job_id)
    await waitJob(data.vps_job_id)
    await waitJob(data.proxy_job_id)
    output(options, data, () => console.log(`created ${data.provision_id} ${name}`))
  }
}

// The kept files of deleted sandboxes, which `create --recover` can attach.
async function recoverable(
  options: OutputOptions & { limit: string; page: string }
): Promise<void> {
  const limit = Number(options.limit)
  const page = pageNumber(options.page)
  const data = await apiJson(
    `${PROVISION_API}/orphan-bkt?include_claimed=false&limit=${limit}&page=${page - 1}`
  )
  checkPage(page, limit, data.total_records)
  output(options, data, () => {
    // Backup times are in milliseconds; none means there is no such backup.
    const time = (ms?: number) => ms ? new Date(ms).toISOString() : undefined
    printRows(
      ["ID", "NAME", "DELETED", "AGENTS-BACKUP", "BROWSER-BACKUP"],
      data.items.map((item: any) => [
        item.provision_id,
        item.name,
        item.created_at,
        time(item.backups?.agents),
        time(item.backups?.browser)
      ])
    )
    printPage(page, limit, data.total_records)
  })
}

// Delete the kept files of a deleted sandbox for good.
async function recoverableRm(
  id: string,
  options: OutputOptions & { force?: boolean }
): Promise<void> {
  if (!options.force) await confirm(`Delete the kept files of ${id} for good?`)
  const data = await apiJson(`${PROVISION_API}/orphan-bkt/${id}`, "DELETE")
  await waitJob(data.delete_job_id)
  output(options, data, () => console.log(`deleted the kept files of ${id}`))
}

async function rm(id: string, options: OutputOptions & { force?: boolean }): Promise<void> {
  if (!options.force) await confirm(`Delete sandbox ${id}?`)
  const data = await apiJson(`${PROVISION_API}/provision/${id}`, "DELETE")
  await waitJob(data.delete_job_id)
  output(options, data, () => console.log(`deleted ${id}`))
}

async function rename(id: string, newName: string, options: OutputOptions): Promise<void> {
  const data = await apiJson(`${PROVISION_API}/sandbox/rename/${id}/${newName}`, "POST")
  output(options, data, () => console.log(`renamed ${id} -> ${newName}`))
}

async function usage(
  id: string,
  options: OutputOptions & { minutes: string; samples: string }
): Promise<void> {
  const data = await apiJson(
    `${PROVISION_API}/sandbox/usage/${id}` +
      `?minutes=${options.minutes}&samples=${options.samples}`
  )
  // Disk usage is only known to the sandbox itself, which is reached by host.
  const host = sandboxHost(await findSandbox(id))
  data.disks = await apiJson(`${hostBase(host!)}/mgr/api/v1/disks`)
  output(options, data, () => {
    const diskUsed = data.disks.disks.reduce(
      (sum: number, disk: any) => sum + disk.usage_bytes, 0
    )
    const gib = (bytes?: number) => bytes == null ? undefined : (bytes / 2 ** 30).toFixed(1)
    printRows(
      [
        "CPU%", "CORES", "MEM%", "MEM-USED-GIB", "MEM-TOTAL-GIB",
        "DISK-USED-GIB", "DISK-TOTAL-GIB"
      ],
      [[
        data.cpu_percent.at(-1)?.value.toFixed(1),
        data.cpu_cores,
        data.memory_percent.at(-1)?.value.toFixed(1),
        gib(data.memory_used_bytes.at(-1)?.value),
        gib(data.memory_total_bytes),
        gib(diskUsed),
        gib(data.disks.capacity_bytes)
      ]]
    )
  })
}

async function agents(id: string, options: OutputOptions): Promise<void> {
  const data = await apiJson(`${PROVISION_API}/sandbox/agents/${id}`)
  output(options, data, () => {
    printRows(
      ["AGENT", "NAME", "MODEL-ID", "MODEL"],
      data.agents.map((agent: any) => [
        agent.id,
        agent.display_name,
        agent.model_rid,
        agent.model?.model_id
      ])
    )
  })
}

// Change some agents: the route replaces the whole agent list, so read it,
// apply `change`, and send all of it back.
async function updateAgents(id: string, change: (agents: any[]) => any[]): Promise<any> {
  const url = `${PROVISION_API}/sandbox/agents/${id}`
  const agents = change((await apiJson(url)).agents).map((agent) => ({
    id: agent.id,
    display_name: agent.display_name,
    model_rid: agent.model_rid
  }))
  const data = await apiJson(url, "PUT", { agents })
  await waitJob(data.reload_job_id)
  return data
}

// Set the messaging apps (kind ims) or vaults of some agents, e.g.
// [{ profile_id: "agent-3f9c1a2b7d4e5f60", rids: [30, 29] }].
async function updateConnectors(id: string, kind: string, profiles: unknown[]): Promise<any> {
  const data = await apiJson(
    `${PROVISION_API}/sandbox/${BIND_TABLES[kind]}/${id}`, "PUT", profiles
  )
  await waitJob(data.reload_job_id)
  return data
}

// The one form of a `hc sandbox bind` item, for every kind:
//   "agent-3f9c1a2b7d4e5f60:Research Lead=30,29"
//   -> { agentId: "agent-3f9c1a2b7d4e5f60", name: "Research Lead", ids: "30,29" }
function parseBinding(spec: string): { agentId: string; name: string; ids: string } {
  const [agent, ids, ...afterIds] = spec.split("=")
  const [agentId, name, ...afterName] = agent.split(":")
  if (ids === undefined || name === undefined || afterIds.length || afterName.length) {
    throw new Error(
      `bad item "${spec}": expected <agent-id>:<display name>=<id>,<id> ` +
        'with one ":" and one "=", e.g. "agent-3f9c1a2b7d4e5f60:Research Lead=104" ' +
        'or "agent-3f9c1a2b7d4e5f60:=30,29"'
    )
  }
  return { agentId, name, ids }
}

// Set the agents named, and leave every other agent as it is. Values go to
// the server as typed.
//   agents "agent-3f9c1a2b7d4e5f60:Research Lead=105"
//       display name and model connector; the agent is created if new
//   ims agent-3f9c1a2b7d4e5f60:=30,29
//       the agent's messaging apps
//   vaults agent-3f9c1a2b7d4e5f60:=2
//       the agent's vaults
async function bind(
  id: string,
  kind: string,
  specs: string[],
  options: OutputOptions
): Promise<void> {
  const bindings = specs.map(parseBinding)
  let data
  if (kind === "agents") {
    data = await updateAgents(id, (agents) => {
      // A Map keeps each agent's place; a new agent goes last.
      const byId = new Map(agents.map((agent) => [agent.id, agent]))
      for (const { agentId, name, ids } of bindings) {
        // An empty name or model means none.
        byId.set(agentId, { id: agentId, display_name: name || null, model_rid: ids || null })
      }
      return [...byId.values()]
    })
  } else {
    data = await updateConnectors(id, kind, bindings.map(({ agentId, ids }) => (
      { profile_id: agentId, rids: ids.split(",") }
    )))
  }
  output(options, data, () => console.log(`${kind} set: ${specs.join(" ")}`))
}

// Remove the agents named (kind agents), or all of their messaging apps or
// vaults (kind ims or vaults).
async function unbind(
  id: string,
  kind: string,
  agentIds: string[],
  options: OutputOptions & { force?: boolean }
): Promise<void> {
  let data
  if (kind === "agents") {
    if (!options.force) {
      await confirm(`Remove the agent(s) ${agentIds.join(", ")} and their data?`)
    }
    data = await updateAgents(id, (agents) => {
      for (const agentId of agentIds) {
        if (!agents.some((agent) => agent.id === agentId)) {
          throw new Error(`no such agent: ${agentId}`)
        }
      }
      return agents.filter((agent) => !agentIds.includes(agent.id))
    })
  } else {
    data = await updateConnectors(
      id, kind, agentIds.map((agentId) => ({ profile_id: agentId, rids: [] }))
    )
  }
  output(options, data, () => console.log(`${kind} removed: ${agentIds.join(" ")}`))
}

async function persona(id: string, file: string, options: AgentOptions): Promise<void> {
  const data = await apiJson(
    `${PROVISION_API}/sandbox/persona/${id}`,
    "PUT",
    [{ profile_id: options.agent, prompt: fs.readFileSync(file, "utf8") }]
  )
  await waitJob(data.reload_job_id)
  output(options, data, () => console.log(`persona updated for ${options.agent}`))
}

async function timezone(id: string, tz: string, options: OutputOptions): Promise<void> {
  const data = await apiJson(`${PROVISION_API}/sandbox/timezone/${id}`, "POST", {
    timezone: tz
  })
  await waitJob(data.reload_job_id)
  output(options, data, () => console.log(`timezone set to ${tz}`))
}

async function inspect(host: string): Promise<void> {
  const url = `${hostBase(host)}/mgr/api/v1/overview`
  console.log(await apiRequest(url))
}

async function getSyncToken(host: string): Promise<void> {
  const url = `${hostBase(host)}/mgr/api/v1/rsync/token`
  console.log(await apiRequest(url))
}

// Print the value that `hc safe-expose` and `hc safe-forward` take: the
// sandbox's tunnel address and credentials as base64url JSON.
async function getEndpoint(id: string): Promise<void> {
  const row = await findSandbox(id)
  // Tunnel data is an object, e.g. {server, destination, uuid, ...}.
  if (typeof row.mapped_ports?.reverse_ssh !== "object" || !row.mapped_ports.reverse_ssh) {
    throw new Error(
      `sandbox ${id} has no endpoint; only sandboxes created with the tunnel have one`
    )
  }
  const keys = await apiJson(`${hostBase(sandboxHost(row)!)}/mgr/api/v1/ssh/key`)
  console.log(Buffer.from(JSON.stringify({
    ...row.mapped_ports.reverse_ssh,
    ...keys.key
  })).toString("base64url"))
}

// Show when the sandbox's files were last backed up, start a backup now, or
// list a folder of the backup. The agent cannot reach these services, so this
// is not done through `msg`.
async function fileBackup(
  host: string,
  options: OutputOptions & { trigger?: boolean; list?: string; page: string }
): Promise<void> {
  if (options.list) {
    const page = pageNumber(options.page)
    const data = await apiJson(
      `${hostBase(host)}/file-api-bkup/api/files` +
        `?dir=${encodeURIComponent(options.list)}&page=${page}`
    )
    checkPage(page, data.pagination.limit, data.pagination.totalItems)
    output(options, data, () => {
      printRows(
        ["TYPE", "SIZE", "MODIFIED", "PATH"],
        data.items.map((item: any) => [
          item.isDir ? "dir" : "file",
          item.isDir ? undefined : byteSize(item.size),
          new Date(item.mtime).toISOString(),
          item.path
        ])
      )
      printPage(page, data.pagination.limit, data.pagination.totalItems)
    })
  } else if (options.trigger) {
    const data = await apiJson(`${hostBase(host)}/backup/api/v1/trigger`, "POST")
    output(options, data, () => console.log(`file backup started on ${host}`))
  } else {
    const data = await apiJson(`${hostBase(host)}/backup/api/v1/last_time`)
    output(options, data, () => {
      printRows(
        ["LAST-START", "LAST-FINISH", "QUOTA-EXCEEDED"],
        [[data.start_time, data.end_time, data.quota_exceeded]]
      )
    })
  }
}

// Restart the agent's container without going through the agent, so that it
// also works when the agent is stuck.
async function restart(host: string, options: OutputOptions): Promise<void> {
  const data = await apiJson(`${hostBase(host)}/mgr/api/v1/restart`, "POST")
  output(options, data, () => console.log(`restarted the agent of ${host}`))
}

// Send one message to an agent and print its reply as it arrives. The
// conversation key is printed last; pass it back to continue that conversation.
// Each tool call and its result is printed too, on stderr, unless
// --no-toolcall-print is given:
//   > terminal {"command": "date -u"}
//   < {"output": "Tue Nov 10 14:12:00 UTC 2026", "exit_code": 0}
async function msg(
  host: string,
  message: string,
  options: AgentOptions & { conversation?: string; toolcallPrint: boolean }
): Promise<void> {
  const conversation = options.conversation ?? `conv_${crypto.randomUUID()}`
  // Agents other than the default one are served under /p/<profile>.
  const prefix = options.agent === "default" ? "" : `/p/${options.agent}`
  const res = await apiFetch(
    `${hostBase(host)}/openai-endpoint${prefix}/v1/responses`,
    "POST",
    {
      model: "hermes-agent",
      stream: true,
      store: true,
      input: [{ role: "user", content: message }],
      conversation
    },
    { Accept: "text/event-stream", Authorization: `Bearer ${AGENT_API_KEY}` }
  )
  let text = ""
  const activity: any[] = []
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of res.body!) {
    buffer += decoder.decode(chunk, { stream: true })
    // Server-sent events are separated by a blank line.
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop()!
    for (const event of events) {
      const type = event.match(/^event: *(.*)$/m)?.[1]
      const data = event.match(/^data: *(.*)$/m)?.[1]
      if (type === "response.output_text.delta") {
        const delta = JSON.parse(data!).delta
        text += delta
        if (!options.json) process.stdout.write(delta)
      } else if (type === "response.output_item.done" && options.toolcallPrint) {
        const item = JSON.parse(data!).item
        if (item.type === "function_call") {
          activity.push({ tool: item.name, arguments: item.arguments })
          console.error(`> ${item.name} ${item.arguments}`)
        } else if (item.type === "function_call_output") {
          const result = item.output.map((part: any) => part.text).join("")
          activity.push({ result })
          console.error(`< ${result}`)
        }
      } else if (type === "response.failed") {
        throw new Error(`agent failed: ${data}`)
      }
    }
  }
  output(options, { conversation, text, ...(options.toolcallPrint ? { activity } : {}) }, () => {
    console.log(`\nconversation: ${conversation}`)
  })
}

// Browser egress WireGuard info (keys, health), or the switch status.
async function egressGet(host: string, switchStatus?: boolean): Promise<void> {
  const url = switchStatus
    ? `${hostBase(host)}/mgr/api/v1/browser/egress-switch`
    : `${hostBase(host)}/mgr/api/v1/browser/egress-connect`
  console.log(await apiRequest(url))
}

// Turn cloud egress on/off, optionally registering the client public key first.
async function egressSet(host: string, action: string, publicKey?: string): Promise<void> {
  if (action === "on") {
    if (publicKey) {
      const connectUrl = `${hostBase(host)}/mgr/api/v1/browser/egress-connect`
      console.log(await apiRequest(connectUrl, "POST", { public_key: publicKey }))
    }
    console.log(await apiRequest(`${hostBase(host)}/mgr/api/v1/browser/egress-switch`, "PUT"))
  } else if (action === "off") {
    console.log(await apiRequest(`${hostBase(host)}/mgr/api/v1/browser/egress-switch`, "DELETE"))
  } else {
    throw new Error("action must be 'on' or 'off'")
  }
}

export function registerSandbox(program: Command): void {
  const sandbox = program.command("sandbox").description("manage HighClaws sandboxes")

  sandbox
    .command("ls")
    .description("list sandboxes")
    .option("--limit <n>", "maximum number of sandboxes to return", DEFAULT_PAGE_SIZE)
    .option("--page <n>", "page number, from 1", "1")
    .option("--deleted", "include deleted sandboxes")
    .option("--json", "print the API response JSON")
    .action(ls)

  sandbox
    .command("tiers")
    .description("list the sizes a sandbox can be created with")
    .option("--json", "print the API response JSON")
    .action(tiers)

  sandbox
    .command("create <tier> <name>")
    .description("create a sandbox of a tier from `hc sandbox tiers` and wait until it is provisioned")
    .option("--model <connector-id>", "model connector for the default agent")
    .option("--timezone <tz>", "sandbox timezone, e.g. Asia/Shanghai")
    .option("--recover <id>", "attach the kept files of a deleted sandbox from `hc sandbox recoverable`")
    .option("--restore-agents", "with --recover: restore its agents backup")
    .option("--restore-browser", "with --recover: restore its browser backup")
    .option("--detach", "return at once; check progress with `hc sandbox job`")
    .option("--json", "print the API response JSON")
    .action(create)

  sandbox
    .command("job <job-id>")
    .description("show the progress of a background job, e.g. from `create --detach`")
    .option("--wait", "follow the job until it ends")
    .option("--json", "print the API response JSON")
    .action(job)

  sandbox
    .command("rm <id>")
    .description("delete a sandbox")
    .option("--force", "do not ask for confirmation")
    .option("--json", "print the API response JSON")
    .action(rm)

  sandbox
    .command("rename <id> <new-name>")
    .description("rename a sandbox")
    .option("--json", "print the API response JSON")
    .action(rename)

  sandbox
    .command("usage <id>")
    .description("show the latest CPU, memory, and disk usage")
    .option("--minutes <n>", "time window to sample", "1440")
    .option("--samples <n>", "number of samples in the window", "120")
    .option("--json", "print the API response JSON")
    .action(usage)

  sandbox
    .command("agents <id>")
    .description("list the agents of a sandbox")
    .option("--json", "print the API response JSON")
    .action(agents)

  sandbox
    .command("recoverable")
    .description("list deleted sandboxes whose files can be recovered into a new one")
    .option("--limit <n>", "maximum number to return", DEFAULT_PAGE_SIZE)
    .option("--page <n>", "page number, from 1", "1")
    .option("--json", "print the API response JSON")
    .action(recoverable)

  sandbox
    .command("recoverable-rm <id>")
    .description("delete the kept files of a deleted sandbox for good")
    .option("--force", "do not ask for confirmation")
    .option("--json", "print the API response JSON")
    .action(recoverableRm)

  sandbox
    .command("bind <id>")
    .addArgument(new Argument("<kind>").choices(BIND_KINDS))
    .argument("<specs...>")
    .description(
      "set the agents named and leave the others as they are. " +
        "Every item is <agent-id>:<display name>=<id>,<id>. " +
        "agents: the display name and one model connector ID " +
        "(the agent is created if new). " +
        "ims|vaults: the connector IDs; the name part is left empty"
    )
    .option("--json", "print the API response JSON")
    .action(bind)

  sandbox
    .command("unbind <id>")
    .addArgument(new Argument("<kind>").choices(BIND_KINDS))
    .argument("<agent-ids...>")
    .description(
      "agents: remove the agents named. " +
        "ims|vaults: remove all messaging apps or vaults of the agents named"
    )
    .option("--force", "agents: do not ask for confirmation")
    .option("--json", "print the API response JSON")
    .action(unbind)

  sandbox
    .command("persona <id> <file>")
    .description("set an agent's persona prompt from a text file")
    .option("--agent <profile>", "agent to change", "default")
    .option("--json", "print the API response JSON")
    .action(persona)

  sandbox
    .command("timezone <id> <tz>")
    .description("set the sandbox timezone, e.g. Asia/Shanghai")
    .option("--json", "print the API response JSON")
    .action(timezone)

  sandbox
    .command("inspect <host>")
    .description("fetch a sandbox manager overview")
    .action(inspect)

  sandbox
    .command("get-sync-token <host>")
    .description("fetch a sandbox rsync sync token")
    .action(getSyncToken)

  sandbox
    .command("get-endpoint <id>")
    .description("print the endpoint for `hc safe-expose` and `hc safe-forward`")
    .action(getEndpoint)

  sandbox
    .command("msg <host> <message>")
    .description("send a message to an agent and print its reply")
    .option("--agent <profile>", "agent to message", "default")
    .option("--conversation <key>", "continue the conversation with this key")
    .option("--no-toolcall-print", "do not print each tool call and its result")
    .option("--json", "print the reply and conversation key as JSON")
    .action(msg)

  sandbox
    .command("file-backup <host>")
    .description("show when the sandbox files were last backed up, or read the backup")
    .option("--trigger", "start a backup now instead")
    .option("--list <dir>", "list a folder of the backup instead, e.g. /")
    .option("--page <n>", "page number for --list, from 1", "1")
    .option("--json", "print the API response JSON")
    .action(fileBackup)

  sandbox
    .command("restart <host>")
    .description("restart the sandbox agent, e.g. when it stops answering")
    .option("--json", "print the API response JSON")
    .action(restart)

  const egress = sandbox
    .command("egress")
    .description("manage sandbox browser egress")

  egress
    .command("get <host>")
    .description("get browser egress WireGuard info")
    .option("--switch-status", "get the egress switch status instead")
    .action((host: string, options: { switchStatus?: boolean }) =>
      egressGet(host, options.switchStatus)
    )

  egress
    .command("set <host> <action>")
    .description("turn cloud egress on or off (action: on|off)")
    .option("--public-key <key>", "register this WireGuard client public key first")
    .action((host: string, action: string, options: { publicKey?: string }) =>
      egressSet(host, action, options.publicKey)
    )
}
