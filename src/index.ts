#!/usr/bin/env node
import { Command } from "commander"
import { registerAdmin } from "./commands/admin"
import { registerAuth } from "./commands/auth"
import { registerExpose } from "./commands/expose"
import { registerProxy } from "./commands/proxy"

const program = new Command()
program
  .name("hc")
  .version("0.1.0")

registerAdmin(program)
registerAuth(program)
registerExpose(program)
registerProxy(program)

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
