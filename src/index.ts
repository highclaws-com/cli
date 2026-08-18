#!/usr/bin/env node
import { Command } from "commander"
import { registerAdmin } from "./commands/admin"

const program = new Command()
program
  .name("hc")
  .version("0.1.0")
  .option("--root <dir>", "repo root containing secrets/cli.json (default: auto-detect from cwd)")

registerAdmin(program)

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
