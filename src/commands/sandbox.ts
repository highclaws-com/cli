import { Command } from "commander"
import { APP_DOMAIN, getUserConfig } from "../config"

async function getPrettyJson(url: string): Promise<string> {
  const auth = getUserConfig("auth")
  if (!auth) throw new Error("not logged in: run `hc auth login`")
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Cookie: `JWT_Token=${auth.jwt}`
    },
    redirect: "manual"
  })
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`)
  return JSON.stringify(await res.json(), null, 2)
}

function hostBase(host: string): string {
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`
  return base.replace(/\/+$/, "")
}

async function ls(limit: string, page: string): Promise<void> {
  const url = `https://${APP_DOMAIN}/provision/api/v1/provisions?show_deleted=false&limit=${limit}&page=${page}`
  console.log(await getPrettyJson(url))
}

async function inspect(host: string): Promise<void> {
  const url = `${hostBase(host)}/mgr/api/v1/overview`
  console.log(await getPrettyJson(url))
}

async function getSyncToken(host: string): Promise<void> {
  const url = `${hostBase(host)}/mgr/api/v1/rsync/token`
  console.log(await getPrettyJson(url))
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
}
