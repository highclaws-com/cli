import crypto from "node:crypto"
import fs from "node:fs"
import readline from "node:readline/promises"
import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiFetch, apiJson, apiRequest, hostBase } from "../api"
import { OutputOptions, output, printPage, printRows } from "../output"
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

async function ls(
  options: OutputOptions & { limit: string; page: string; deleted?: boolean }
): Promise<void> {
  const limit = Number(options.limit)
  const page = Number(options.page)
  const data = await apiJson(
    `${PROVISION_API}/provisions` +
      `?show_deleted=${options.deleted ? "true" : "false"}&limit=${limit}&page=${page}`
  )
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
  options: OutputOptions & { model?: string; timezone?: string; detach?: boolean }
): Promise<void> {
  const query = options.timezone
    ? `?timezone=${encodeURIComponent(options.timezone)}`
    : ""
  const data = await apiJson(`${PROVISION_API}/job/${tier}/${name}${query}`, "POST", {
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

async function rm(id: string, options: OutputOptions & { force?: boolean }): Promise<void> {
  if (!options.force) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await rl.question(`Delete sandbox ${id}? [y/N] `)
    rl.close()
    if (answer.trim().toLowerCase() !== "y") throw new Error("aborted")
  }
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

async function bind(
  id: string,
  kind: string,
  connectorIds: string[],
  options: AgentOptions
): Promise<void> {
  const rids = connectorIds.map(Number)
  let data
  if (kind === "model") {
    if (rids.length !== 1) throw new Error("bind model takes exactly one connector ID")
    // The route replaces the whole agent list, so send every agent back.
    const current = await apiJson(`${PROVISION_API}/sandbox/agents/${id}`)
    if (!current.agents.some((agent: any) => agent.id === options.agent)) {
      throw new Error(`no such agent: ${options.agent}`)
    }
    data = await apiJson(`${PROVISION_API}/sandbox/agents/${id}`, "PUT", {
      agents: current.agents.map((agent: any) => ({
        id: agent.id,
        display_name: agent.display_name,
        model_rid: agent.id === options.agent ? rids[0] : agent.model_rid
      }))
    })
  } else if (BIND_TABLES[kind]) {
    data = await apiJson(
      `${PROVISION_API}/sandbox/${BIND_TABLES[kind]}/${id}`,
      "PUT",
      [{ profile_id: options.agent, rids }]
    )
  } else {
    throw new Error(`kind must be one of: model, ${Object.keys(BIND_TABLES).join(", ")}`)
  }
  await waitJob(data.reload_job_id)
  output(options, data, () => {
    console.log(`bound ${kind} ${connectorIds.join(",") || "(none)"} to ${options.agent}`)
  })
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

// Send one message to an agent and print its reply as it arrives. The
// conversation key is printed last; pass it back to continue that conversation.
async function msg(
  host: string,
  message: string,
  options: AgentOptions & { conversation?: string }
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
      } else if (type === "response.failed") {
        throw new Error(`agent failed: ${data}`)
      }
    }
  }
  output(options, { conversation, text }, () => {
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
    .option("--page <n>", "page index", "0")
    .option("--deleted", "include deleted sandboxes")
    .option("--json", "print the API response JSON")
    .action(ls)

  sandbox
    .command("create <tier> <name>")
    .description("create a sandbox and wait until it is provisioned")
    .option("--model <connector-id>", "model connector for the default agent")
    .option("--timezone <tz>", "sandbox timezone, e.g. Asia/Shanghai")
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
    .command("bind <id> <kind> [connector-ids...]")
    .description(
      "replace an agent's connectors (kind: model|ims|vaults); " +
        "connector IDs are from `hc connector ls`"
    )
    .option("--agent <profile>", "agent to change", "default")
    .option("--json", "print the API response JSON")
    .action(bind)

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
    .option("--json", "print the reply and conversation key as JSON")
    .action(msg)

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
