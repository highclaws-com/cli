import path from "node:path"
import { Command } from "commander"
import { run } from "../exec"

export function registerGui(program: Command): void {
  program
    .command("gui", { isDefault: true })
    .description("open the GUI")
    .action(async () => {
      const hc = process.versions.bun ? [process.execPath] : [process.execPath, __filename]
      const gui = process.platform === "win32" ? "hc-gui.exe" : "hc-gui"
      process.exit(await run(path.join(path.dirname(hc.at(-1)!), gui), hc))
    })
}
