import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiJson } from "../api"
import { OutputOptions, output, printRows } from "../output"

const BILLING_API = `https://${APP_DOMAIN}/billing/api/v1`
const PROVISION_API = `https://${APP_DOMAIN}/provision/api/v1`

// A server identifier as words: "past_due" -> "Past Due".
function humanize(identifier: string): string {
  return identifier
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// A count in short form: 7855572 -> "7.9M".
function bigCount(value: number): string {
  if (value <= 0) return "-"
  const units = ["", "K", "M", "B", "T"]
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1)
  return `${parseFloat((value / 1000 ** i).toFixed(1))}${units[i]}`
}

// The maximum context of a model, e.g. "highclaws/gpt-6-astra:free", looked
// up by its last path part within its provider's models.
function modelContext(contexts: any, model: string): number | undefined {
  const [provider, ...rest] = model.split("/")
  const bucket = contexts[provider] || {}
  const modelId = rest.join("/").split(":")[0].split("/").pop()!.toLowerCase()
  if (modelId in bucket) return bucket[modelId]
  // Best effort: the longest known ID that the model's ID starts with, e.g.
  // "gemini-3.8-flash-high" -> "gemini-3.8-flash".
  const hit = Object.keys(bucket)
    .sort((a, b) => b.length - a.length)
    .find((id) => modelId.startsWith(id))
  return hit ? bucket[hit] : undefined
}

// Tokens used per model in the current billing period, biggest first.
async function modelUsage(options: OutputOptions): Promise<void> {
  const [data, contexts] = await Promise.all([
    apiJson(`${BILLING_API}/quota/free-model`),
    apiJson(`https://${APP_DOMAIN}/connectors/public/model-context`)
  ])
  output(options, data, () => {
    const rows = Object.entries(data.used_quota__model_tokens)
      .map(([model, usage]: [string, any]) => {
        const input = usage.input_tokens || 0
        const outputTokens = usage.output_tokens || 0
        const cacheRead = usage.cache_read_tokens || 0
        const cacheWrite = usage.cache_write_tokens || 0
        // "_" is the price of every model without one of its own.
        const pricing = data.pricing[model] || data.pricing["_"]
        const prices = [`$${pricing.input_price} in`, `$${pricing.output_price} out`]
        if (pricing.cache_read_price != null) prices.push(`$${pricing.cache_read_price} cache`)
        if (pricing.cache_write_price != null) prices.push(`$${pricing.cache_write_price} write`)
        return {
          total: input + outputTokens + cacheRead + cacheWrite,
          cells: [
            model,
            bigCount(input),
            bigCount(outputTokens),
            bigCount(cacheRead),
            bigCount(cacheWrite),
            bigCount(input + outputTokens + cacheRead + cacheWrite),
            bigCount(modelContext(contexts, model) ?? 0),
            prices.join(", ")
          ]
        }
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total)
    printRows(
      [
        "MODEL", "INPUT", "OUTPUT", "CACHE-READ", "CACHE-WRITE", "TOTAL",
        "MAX-CONTEXT", "USD-PER-1M-TOKENS"
      ],
      rows.map((row) => row.cells)
    )
  })
}

// Share used, capped like the console's bars: (7, 4) -> "100%".
function percent(used: number, total: number): string {
  return `${total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0}%`
}

// What the account has used and may use, one row per resource, as on the
// console's account page.
async function quota(options: OutputOptions): Promise<void> {
  const [vps, trial, backup, model, sandboxes] = await Promise.all([
    apiJson(`${BILLING_API}/quota/vps`),
    apiJson(`${BILLING_API}/quota/vps/free-trial-usage`),
    apiJson(`${BILLING_API}/quota/storage`),
    apiJson(`${BILLING_API}/quota/free-model`),
    apiJson(`${PROVISION_API}/provisions?show_deleted=false&limit=100`)
  ])
  // Units held by the sandboxes that exist now.
  const usedVpsUnits = sandboxes.items.reduce(
    (sum: number, row: any) => sum + (row.vps_unit || 1), 0
  )
  output(options, { vps, trial, backup, model, used_vps_units: usedVpsUnits }, () => {
    const rows: unknown[][] = [[
      "compute units",
      usedVpsUnits,
      vps.total_vps_units,
      percent(usedVpsUnits, vps.total_vps_units)
    ]]
    // Only a free-trial plan has trial hours. They run on the clock from the
    // moment the trial starts, whether or not a sandbox is in use.
    if (trial.monthly_trial_seconds != null) {
      rows.push([
        trial.month_trial_started_at ? "trial hours elapsed" : "trial hours (not started)",
        (trial.trial_used_seconds / 3600).toFixed(1),
        (trial.monthly_trial_seconds / 3600).toFixed(1),
        percent(trial.trial_used_seconds, trial.monthly_trial_seconds)
      ])
    }
    // Backups stop once the monthly backup quota is used up.
    rows.push([
      "monthly backup quota (USD)",
      (backup.used_s3_cents / 100).toFixed(2),
      (backup.total_quota_s3_cents / 100).toFixed(2),
      percent(backup.used_s3_cents, backup.total_quota_s3_cents)
    ])
    rows.push([
      "model quota (USD)",
      (model.used_microdollars / 1e6).toFixed(2),
      (model.quota_microdollars / 1e6).toFixed(2),
      percent(model.used_microdollars, model.quota_microdollars)
    ])
    printRows(["RESOURCE", "USED", "TOTAL", "PERCENT"], rows)
  })
}

const LIKELY_ACTIVE_STATUSES = ["active", "trialing", "past_due"]

// The plan status the console shows, e.g. an active recurring plan with
// auto-renew off -> "Not renewing".
function planStatus(data: any): string {
  const status = data.subscription?.paygate_status?.toLowerCase()
  if (!status) {
    return "Inactive"
  } else if (
    LIKELY_ACTIVE_STATUSES.includes(status) &&
    (data.intended_plan ?? data.plan)?.recurring &&
    !data.subscription.paygate_auto_renew
  ) {
    return "Not renewing"
  } else {
    return humanize(status)
  }
}

// Who the account belongs to, then its current plan and billing cycle.
async function plan(options: OutputOptions): Promise<void> {
  const [data, profile] = await Promise.all([
    apiJson(`${BILLING_API}/subscription`),
    apiJson(`https://${APP_DOMAIN}/auth/profile`)
  ])
  output(options, { ...data, profile }, () => {
    console.log(`${profile.email}, joined ${profile.created_at.slice(0, 10)}`)
    // A negative balance is credit, applied to future subscriptions.
    const name = (data.intended_plan ?? data.plan)?.name
    const creditCents = Math.max(0, -(data.subscription?.paygate_balance_cents || 0))
    printRows(
      ["PLAN", "STATUS", "COMPUTE-UNITS", "TRIAL-HOURS/MONTH", "CREDIT-USD", "CYCLE-END"],
      [[
        name ? humanize(name) : "No active plan",
        planStatus(data),
        data.subscription?.quantity,
        data.plan?.monthly_quota__trial_hours,
        (creditCents / 100).toFixed(2),
        data.subscription?.cycle_end
      ]]
    )
  })
}

export function registerAccount(program: Command): void {
  const account = program.command("account").description("show the account, its plan, and its usage")

  account
    .command("model-usage")
    .description("show the tokens used per model in the current billing period")
    .option("--json", "print the API response JSON")
    .action(modelUsage)

  account
    .command("quota")
    .description("show what the account has used and may use")
    .option("--json", "print the API responses as JSON")
    .action(quota)

  account
    .command("plan")
    .description("show whose account it is, its current plan, and its billing cycle")
    .option("--json", "print the API responses as JSON")
    .action(plan)
}
