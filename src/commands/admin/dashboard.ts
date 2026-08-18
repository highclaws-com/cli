import { Command } from "commander"
import { LoadedConfig } from "../../config"

export function registerDashboard(admin: Command, getCtx: () => LoadedConfig): void {
  const dashboard = admin
    .command("dashboard")
    .description("print the dashboard URLs")
    .action(() => {
      const { config } = getCtx()
      const boards = config.dashboards
      if (!boards || Object.keys(boards).length === 0) {
        throw new Error("no 'dashboards' entries in secrets/cli.json")
      }
      const width = Math.max(...Object.keys(boards).map((k) => k.length))
      for (const [name, d] of Object.entries(boards)) {
        const memo = d.memo ? `  (memo: ${d.memo})` : ""
        console.log(`${name.padEnd(width)} : ${d.url}${memo}`)
      }
    })
}
