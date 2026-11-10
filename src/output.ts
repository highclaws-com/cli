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
