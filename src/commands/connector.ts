import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiJson } from "../api"
import { OutputOptions, output, printPage, printRows } from "../output"

const CONNECTORS_API = `https://${APP_DOMAIN}/connectors/api/v1`

// Same page size as the web console.
export const DEFAULT_PAGE_SIZE = "10"

// `hc connector ls <kind>` -> the preset list route.
const PRESET_ROUTES: Record<string, string> = {
  models: "models",
  "free-models": "free_models",
  ims: "connectors",
  vaults: "passwords"
}

interface ListOptions extends OutputOptions {
  limit: string
  page: string
}

async function ls(kind: string, options: ListOptions): Promise<void> {
  const route = PRESET_ROUTES[kind]
  if (!route) {
    throw new Error(`kind must be one of: ${Object.keys(PRESET_ROUTES).join(", ")}`)
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
    // Only model presets have a model.
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
    .description("query saved model, messaging app, and vault presets")

  connector
    .command("ls <kind>")
    .description(`list presets (kind: ${Object.keys(PRESET_ROUTES).join("|")})`)
    .option("--limit <n>", "maximum number of presets to return", DEFAULT_PAGE_SIZE)
    .option("--page <n>", "page index", "0")
    .option("--json", "print the API response JSON")
    .action(ls)
}
