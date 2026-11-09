import { Command } from "commander"
import { USER_CONFIG_PATH, getUserConfig, updateUserConfig } from "../config"
import { run } from "../exec"
import { ensureProxyHelper } from "../proxy-helper"
import { tunnelValue } from "./safe-expose"

// Forwards this computer's 127.0.0.1:<port> to the sandbox's TCP port 2023,
// whatever protocol the service there speaks.
async function safeForward(
  port: string,
  endpoint: string | undefined
): Promise<void> {
  if (endpoint) {
    updateUserConfig("reverse_ssh", { endpoint })
    console.error(`Saved endpoint to ${USER_CONFIG_PATH}`)
  } else {
    endpoint = getUserConfig("reverse_ssh")?.endpoint
    if (!endpoint) throw new Error("no saved endpoint; pass <endpoint> once")
  }
  const decoded = JSON.parse(
    Buffer.from(endpoint, "base64url").toString("utf8")
  )
  // "10.20.0.5:2022" -> "10.20.0.5:2023"
  const destination = decoded.destination.replace(/:\d+$/, ":2023")
  const helper = await ensureProxyHelper(false)
  console.error(`Forwarding 127.0.0.1:${port} to the sandbox's port 2023`)
  const code = await run(
    helper,
    ["forward", port, tunnelValue(decoded, destination)]
  )
  if (code !== 0) throw new Error(`proxy helper exited with code ${code}`)
}

export function registerSafeForward(program: Command): void {
  program
    .command("safe-forward <port> [endpoint]")
    .description("forward a local TCP port to the sandbox's private port 2023")
    .action(safeForward)
}
