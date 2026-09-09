#!/usr/bin/env node
import { Command } from "commander"
import { registerAdmin } from "./commands/admin"
import { registerAuth } from "./commands/auth"
import { registerExpose } from "./commands/expose"

const program = new Command()
program
  .name("hc")
  .version("0.1.0")

registerAdmin(program)
registerAuth(program)
registerExpose(program)

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
