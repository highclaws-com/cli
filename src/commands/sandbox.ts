import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiRequest, hostBase } from "../api"

async function ls(limit: string, page: string): Promise<void> {
  const url = `https://${APP_DOMAIN}/provision/api/v1/provisions?show_deleted=false&limit=${limit}&page=${page}`
  console.log(await apiRequest(url))
}

async function inspect(host: string): Promise<void> {
  const url = `${hostBase(host)}/mgr/api/v1/overview`
  console.log(await apiRequest(url))
}

async function getSyncToken(host: string): Promise<void> {
  const url = `${hostBase(host)}/mgr/api/v1/rsync/token`
  console.log(await apiRequest(url))
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
  const sandbox = program.command("sandbox").description("query HighClaws sandboxes")

  sandbox
    .command("ls")
    .description("list sandboxes")
    .option("--limit <n>", "maximum number of sandboxes to return", "10")
    .option("--page <n>", "page index", "0")
    .action((options: { limit: string; page: string }) => ls(options.limit, options.page))

  sandbox
    .command("inspect <host>")
    .description("fetch a sandbox manager overview")
    .action(inspect)

  sandbox
    .command("get-sync-token <host>")
    .description("fetch a sandbox rsync sync token")
    .action(getSyncToken)

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
