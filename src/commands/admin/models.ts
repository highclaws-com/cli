import { Command } from "commander"
import { LoadedConfig, extractEnv } from "../../config"

export function registerModels(admin: Command, getCtx: () => LoadedConfig): void {
  const models = admin
    .command("models")
    .description("fetch and display the public model context")
    .action(async () => {
      const { env } = getCtx()
      const [domain] = extractEnv(env, ["GATEWAY_DOMAIN"])
      const url = `https://${domain}/connectors/public/model-context`
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
