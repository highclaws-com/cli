import { spawn } from "node:child_process"
import { Command } from "commander"
import { LoadedConfig } from "../../config"

export function registerDashboard(admin: Command, getCtx: () => LoadedConfig): void {
  const dashboard = admin
    .command("dashboard")
    .description("open the dashboards in the browser")
    .action(() => {
      const { config } = getCtx()
      if (!config.domain) {
        throw new Error("no 'domain' key in secrets/cli.json")
      }
      const url = `https://${config.domain}/grafana/dashboards`
      console.log(url)
      const [openerCmd, openerArgs] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]]
      const child = spawn(openerCmd, openerArgs, { detached: true, stdio: "ignore" })
      child.on("error", () => {
        console.log(`note: could not launch a browser; visit ${url} manually`)
      })
      child.unref()
    })
}
