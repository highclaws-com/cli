import { Command } from "commander"
import { LoadedConfig } from "../../config"

export function registerModels(admin: Command, getCtx: () => LoadedConfig): void {
  const models = admin
    .command("models")
    .description("fetch and display the public model context")
    .action(async () => {
      const { config } = getCtx()
      if (!config.domain) {
        throw new Error("no 'domain' key in secrets/cli.json")
      }
      const url = `https://${config.domain}/connectors/public/model-context`
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`request failed: HTTP ${res.status} ${res.statusText}`)
      }
      const body = await res.text()
      let pretty = body
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2)
      } catch {
        // not JSON; display raw
      }
      console.log(pretty)
    })
}
