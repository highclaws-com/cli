import readline from "node:readline/promises"

export interface OutputOptions {
  json?: boolean
}

// Print aligned columns, e.g.
//   ID  NAME
//   7   demo
export function printRows(header: string[], rows: unknown[][]): void {
  const lines = [header, ...rows].map((row) => row.map((cell) => String(cell ?? "-")))
  const widths = header.map((_, i) => Math.max(...lines.map((line) => line[i].length)))
  for (const line of lines) {
    console.log(line.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd())
  }
}

// A size in bytes in short form: 7158534 -> "6.8 MB".
export function byteSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`
}

// Ask a yes/no question on the terminal; anything but "y" fails the command.
export async function confirm(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  if (answer.trim().toLowerCase() !== "y") throw new Error("aborted")
}

// With --json print the API response as-is, otherwise the readable form.
export function output(options: OutputOptions, data: unknown, readable: () => void): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    readable()
  }
}

// The `--page` value as a number; pages count from 1.
export function pageNumber(value: string): number {
  const page = Number(value)
  if (!(page >= 1)) throw new Error("--page must be 1 or more")
  return page
}

// Fail when `page` is not one of the pages of a list of `total` items.
export function checkPage(page: number, limit: number, total: number): void {
  const pages = Math.max(1, Math.ceil(total / limit))
  if (page > pages) {
    throw new Error(`no page ${page}: the list has ${pages} page(s)`)
  }
}

// Page position of a paginated list, on stderr so that rows stay pipeable.
// Pages count from 1, as `--page` does.
export function printPage(page: number, limit: number, total: number): void {
  const pages = Math.max(1, Math.ceil(total / limit))
  console.error(`page ${page}/${pages}, ${total} total`)
}
