import { spawn } from "node:child_process"

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: "inherit"
    })
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}
