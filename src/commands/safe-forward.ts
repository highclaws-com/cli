import { Command } from "commander"
import { USER_CONFIG_PATH, getUserConfig, updateUserConfig } from "../config"
import { run } from "../exec"
import { askSecrets } from "../output"
import { ensureProxyHelper } from "../proxy-helper"
import { tunnelValue } from "./safe-expose"

// Sandbox TCP port reserved for the user's private service.
const FORWARD_TCP_PORT = 2023

// Forwards this computer's 127.0.0.1:<port> to the sandbox's
// FORWARD_TCP_PORT, whatever protocol the service there speaks.
async function safeForward(
  port: string,
  options: { reset?: boolean; upgrade?: boolean }
): Promise<void> {
  let endpoint = options.reset ? undefined : getUserConfig("reverse_ssh")?.endpoint
  if (!endpoint) {
    endpoint = (await askSecrets(["Endpoint"]))[0]
    updateUserConfig("reverse_ssh", { endpoint })
    console.error(`Saved endpoint to ${USER_CONFIG_PATH}`)
  }
  const decoded = JSON.parse(
    Buffer.from(endpoint, "base64url").toString("utf8")
  )
  const helper = await ensureProxyHelper(options.upgrade)
  console.error(
    `Forwarding 127.0.0.1:${port} to the sandbox's port ${FORWARD_TCP_PORT}`
  )
  const code = await run(
    helper,
    ["forward", port],
    { env: { TUNNEL: tunnelValue(decoded, FORWARD_TCP_PORT) } }
  )
  if (code !== 0) throw new Error(`proxy helper exited with code ${code}`)
}

export function registerSafeForward(program: Command): void {
  program
    .command("safe-forward <port>")
    .description(
      `forward a local TCP port to the sandbox's port ${FORWARD_TCP_PORT}`
    )
    .option("--reset", "ask for a new endpoint instead of the saved one")
    .option("--upgrade", "download the latest proxy helper")
    .action(safeForward)
}
