#!/usr/bin/env node
import { Command } from "commander"
import { DEFAULT_CLOUDFLARED_VERSION } from "./cloudflared"
import { registerAdmin } from "./commands/admin"
import { registerExpose } from "./commands/expose"

const program = new Command()
program
  .name("hc")
  .version("0.1.0")
  .option("--root <dir>", "repo root containing secrets/cli.json (default: auto-detect from cwd)")
  .option(
    "--cloudflared-version <version>",
    "cloudflared release version",
    DEFAULT_CLOUDFLARED_VERSION
  )

registerAdmin(program)
registerExpose(program)

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
