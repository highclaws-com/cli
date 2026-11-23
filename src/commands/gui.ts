import { Command } from "commander"
import { hc, run, siblingBin } from "../exec"

export function registerGui(program: Command): void {
  program
    .command("gui", { isDefault: true })
    .description("open the GUI")
    .action(async () => {
      process.exit(await run(siblingBin("hc-gui"), hc))
    })
}
