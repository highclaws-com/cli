import { Command } from "commander"
import { run, siblingBin } from "../exec"

export function registerGui(program: Command): void {
  program
    .command("gui", { isDefault: true })
    .description("open the GUI")
    .action(async () => {
      const hc = process.versions.bun ? [process.execPath] : [process.execPath, __filename]
      process.exit(await run(siblingBin("hc-gui"), hc))
    })
}
