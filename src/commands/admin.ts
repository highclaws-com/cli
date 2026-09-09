import { Command } from "commander"
import { AdminContext, loadAdminContext } from "../config"
import { registerBackup } from "./admin/backup"
import { registerDashboard } from "./admin/dashboard"
import { registerDb } from "./admin/db"
import { registerDeploy } from "./admin/deploy"
import { registerInvite } from "./admin/invite"
import { registerJwt } from "./admin/jwt"
import { registerModels } from "./admin/models"
import { registerPve } from "./admin/pve"
import { registerSwarm } from "./admin/swarm"
import { registerWgConnect } from "./admin/wg-connect"

export function registerAdmin(program: Command): void {
  const admin = program
    .command("admin")
    .description("admin operations")
    .option("--root <dir>", "repo root containing secrets/cli.json")
  let loaded: AdminContext | undefined
  admin.hook("preAction", async (_thisCommand, actionCommand) => {
    try {
      loaded = loadAdminContext(actionCommand.opts().root as string | undefined)
    } catch {
      throw new Error(
        "admin requires the source code and secret configuration (secrets/cli.json)\n" +
          "run `cli admin` from a directory inside the repository checkout"
      )
    }
  })
  const getCtx = (): AdminContext => {
    if (!loaded) throw new Error("admin context not initialized")
    return loaded
  }
  registerBackup(admin, getCtx)
  registerDashboard(admin, getCtx)
  registerDb(admin, getCtx)
  registerDeploy(admin, getCtx)
  registerInvite(admin, getCtx)
  registerJwt(admin, getCtx)
  registerModels(admin, getCtx)
  registerPve(admin, getCtx)
  registerSwarm(admin, getCtx)
  registerWgConnect(admin, getCtx)
}
