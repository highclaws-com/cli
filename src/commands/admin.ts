import { Command } from "commander"
import { loadConfig, LoadedConfig } from "../config"
import { registerDb } from "./admin/db"

export function registerAdmin(program: Command): void {
  const admin = program.command("admin").description("admin operations")
  let loaded: LoadedConfig | undefined
  admin.hook("preAction", async (_thisCommand, actionCommand) => {
    try {
      loaded = loadConfig(actionCommand.optsWithGlobals().root as string | undefined)
    } catch {
      throw new Error(
        "admin requires the source code and secret configuration (secrets/cli.json)\n" +
          "run `cli admin` from a directory inside the repository checkout"
      )
    }
  })
  const getCtx = (): LoadedConfig => {
    if (!loaded) throw new Error("admin context not initialized")
    return loaded
  }
  registerDb(admin, getCtx)
}
