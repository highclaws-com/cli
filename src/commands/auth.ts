import readline from "node:readline/promises"
import { Command } from "commander"
import {
  USER_CONFIG_PATH,
  updateUserConfig
} from "../config"

const LOGIN_CALLBACK_URL = "https://highclaws.com/u/code"
const LOGIN_URL = `https://highclaws.com/u/login?next=${encodeURIComponent(LOGIN_CALLBACK_URL)}`

function validateJwt(token: string): void {
  const parts = token.split(".")
  if (parts.length !== 3) {
    throw new Error("invalid login code")
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown
      iss?: unknown
      uid?: unknown
    }
    if (payload.iss !== "gateway-auth" || !Number.isInteger(Number(payload.uid))) {
      throw new Error("unexpected JWT payload")
    }
    if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error("JWT is expired")
    }
  } catch (e) {
    throw new Error(`invalid login code: ${(e as Error).message}`)
  }
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("manage user authentication")

  auth
    .command("login")
    .description("log in through highclaws.com")
    .action(async () => {
      console.log(`Open this URL in your browser:\n${LOGIN_URL}`)
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const token = (await rl.question("Paste login code: ")).trim()
      rl.close()
      validateJwt(token)
      updateUserConfig("auth", { jwt: token })
      console.log(`Logged in. Credentials saved to ${USER_CONFIG_PATH}`)
    })

  auth
    .command("logout")
    .description("remove local credentials")
    .action(() => {
      updateUserConfig("auth", undefined)
      console.log("Logged out locally.")
    })
}
