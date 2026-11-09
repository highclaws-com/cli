#!/usr/bin/env node
import { Command } from "commander"
import { registerAdmin } from "./commands/admin"
import { registerAuth } from "./commands/auth"
import { registerExpose } from "./commands/expose"
import { registerProxy } from "./commands/proxy"
import { registerSandbox } from "./commands/sandbox"
import { registerSafeExpose } from "./commands/safe-expose"
import { registerSafeForward } from "./commands/safe-forward"
import { registerSync } from "./commands/sync"

const program = new Command()
program.name("hc")

registerAdmin(program)
registerAuth(program)
registerExpose(program)
registerProxy(program)
registerSandbox(program)
registerSafeExpose(program)
registerSafeForward(program)
registerSync(program)

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
