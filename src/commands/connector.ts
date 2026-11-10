import fs from "node:fs"
import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiFetch, apiJson } from "../api"
import { OutputOptions, output, printPage, printRows } from "../output"

const CONNECTORS_API = `https://${APP_DOMAIN}/connectors/api/v1`

// Same page size as the web console.
export const DEFAULT_PAGE_SIZE = "10"

// `hc connector ls <kind>` -> the connector list route.
const CONNECTOR_ROUTES: Record<string, string> = {
  models: "models",
  "free-models": "free_models",
  ims: "connectors",
  vaults: "passwords"
}

const QR_POLL_MS = 2000

// The route of a kind that can be written to: every kind but free-models.
function writableRoute(kind: string): string {
  const route = CONNECTOR_ROUTES[kind]
  if (!route || route === "free_models") {
    throw new Error("kind must be one of: models, ims, vaults")
  }
  return route
}

// Start a QR login, save the QR image to `file` for the user to scan, and
// return the key the login yields once the user confirms it.
async function qrLogin(file: string): Promise<Record<string, string>> {
  const qr = `${CONNECTORS_API}/connectors/weixin/qr`
  const session = await apiJson(`${qr}/start`, "POST")
  const image = await apiFetch(`${qr}/${session.session_id}.svg`, "GET", undefined, {
    Accept: "image/svg+xml"
  })
  fs.writeFileSync(file, await image.text())
  console.error(`scan the QR code in ${file}`)
  while ((await apiJson(`${qr}/${session.session_id}/status`)).status !== "confirmed") {
    await new Promise((resolve) => setTimeout(resolve, QR_POLL_MS))
  }
  return (await apiJson(`${qr}/${session.session_id}/key`)).key
}

interface NewOptions extends OutputOptions {
  provider: string
  name: string
  model?: string
  upstream?: string
  authMethod: string
  key: string[]
  keyFile?: string
  qr?: string
}

async function create(kind: string, options: NewOptions): Promise<void> {
  const route = writableRoute(kind)
  let key: Record<string, string>
  if (options.qr) {
    key = await qrLogin(options.qr)
  } else if (options.keyFile) {
    key = JSON.parse(fs.readFileSync(options.keyFile, "utf8"))
  } else {
    // "bot_token=abc=d" -> ["bot_token", "abc=d"]
    key = Object.fromEntries(options.key.map((pair) => {
      const at = pair.indexOf("=")
      return [pair.slice(0, at), pair.slice(at + 1)]
    }))
  }
  const data = await apiJson(`${CONNECTORS_API}/${route}`, "POST", {
    name: options.name,
    provider: options.provider,
    model_id: options.model,
    upstream_overwrite: options.upstream,
    auth_method: options.authMethod,
    key
  })
  output(options, data, () => console.log(`created ${kind} ${data.id} ${options.name}`))
}

async function rm(kind: string, id: string, options: OutputOptions): Promise<void> {
  const data = await apiJson(`${CONNECTORS_API}/${writableRoute(kind)}/${id}`, "DELETE")
  output(options, data, () => console.log(`deleted ${kind} ${id}`))
}

interface ListOptions extends OutputOptions {
  limit: string
  page: string
}

async function ls(kind: string, options: ListOptions): Promise<void> {
  const route = CONNECTOR_ROUTES[kind]
  if (!route) {
    throw new Error(`kind must be one of: ${Object.keys(CONNECTOR_ROUTES).join(", ")}`)
  }
  const limit = Number(options.limit)
  const page = Number(options.page)
  // A route may return fewer rows than asked, e.g. free models come 5 at a
  // time, so keep asking until the page is full or the list ends.
  const data = { items: [] as any[], total_records: 0 }
  let chunk
  do {
    const offset = page * limit + data.items.length
    chunk = await apiJson(
      `${CONNECTORS_API}/${route}?limit=${limit - data.items.length}&offset=${offset}`
    )
    data.items.push(...chunk.items)
    data.total_records = chunk.total_records
  } while (
    chunk.items.length > 0 &&
    data.items.length < limit &&
    page * limit + data.items.length < data.total_records
  )
  data.items = data.items.slice(0, limit)
  output(options, data, () => {
    // Only model connectors have a model.
    const isModel = route === "models" || route === "free_models"
    printRows(
      ["ID", "NAME", "PROVIDER", ...(isModel ? ["MODEL"] : []), "KEY", "USED-BY"],
      data.items.map((item) => [
        item.id,
        item.name,
        item.provider,
        ...(isModel ? [item.model_id] : []),
        item.redacted_token,
        item.used_by_total
      ])
    )
    printPage(page, limit, data.total_records)
  })
}

export function registerConnector(program: Command): void {
  const connector = program
    .command("connector")
    .description("manage saved model, messaging app, and vault connectors")

  connector
    .command("ls <kind>")
    .description(`list connectors (kind: ${Object.keys(CONNECTOR_ROUTES).join("|")})`)
    .option("--limit <n>", "maximum number of connectors to return", DEFAULT_PAGE_SIZE)
    .option("--page <n>", "page index", "0")
    .option("--json", "print the API response JSON")
    .action(ls)

  connector
    .command("new <kind>")
    .description("save a connector (kind: models|ims|vaults)")
    .requiredOption("--provider <provider>", "provider, e.g. Discord")
    .requiredOption("--name <name>", "name shown in lists")
    .option("--model <model-id>", "models only: the provider's model ID")
    .option("--upstream <value>", "models only: endpoint that replaces the provider's own")
    .option("--auth-method <method>", "token or oauth_codex", "token")
    .option(
      "--key <field=value>",
      "one credential field; repeat for more",
      (pair: string, pairs: string[]) => [...pairs, pair],
      []
    )
    .option("--key-file <file>", "JSON file holding all credential fields")
    .option("--qr <file>", "log in by QR code: save the code to this file and wait for the scan")
    .option("--json", "print the API response JSON")
    .action(create)

  connector
    .command("rm <kind> <id>")
    .description("delete a saved connector (kind: models|ims|vaults)")
    .option("--json", "print the API response JSON")
    .action(rm)
}
