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

export function escapeShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export function runCapture(
  cmd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "inherit"]
    })
    let stdout = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }))
  })
}
