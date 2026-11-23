import path from "node:path"
import { Command } from "commander"
import { run } from "../exec"

export function registerGui(program: Command): void {
  program
    .command("gui")
    .description("show the tray icon")
    .action(async () => {
      process.exit(await run(
        path.join(__dirname, "..", "bin", "hc-gui"),
        [process.execPath, process.argv[1]]
      ))
    })
}
