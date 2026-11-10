import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiJson } from "../api"
import { OutputOptions, output, printRows } from "../output"

const BILLING_API = `https://${APP_DOMAIN}/billing/api/v1`
const PROVISION_API = `https://${APP_DOMAIN}/provision/api/v1`

// Share used, capped like the console's bars: (7, 4) -> "100%".
function percent(used: number, total: number): string {
  return `${total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0}%`
}

// What the account has used and may use, one row per resource, as on the
// console's account page.
async function quota(options: OutputOptions): Promise<void> {
  const [vps, trial, storage, model, sandboxes] = await Promise.all([
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
  output(options, { vps, trial, storage, model, used_vps_units: usedVpsUnits }, () => {
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
    // Backups stop once the monthly backup quota is used up; the console
    // shows it as a share only.
    rows.push([
      "monthly backup quota",
      undefined,
      undefined,
      percent(storage.used_s3_cents, storage.total_quota_s3_cents)
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
// auto-renew off -> "not renewing".
function planStatus(data: any): string {
  const status = data.subscription?.paygate_status?.toLowerCase()
  if (!status) {
    return "inactive"
  } else if (
    LIKELY_ACTIVE_STATUSES.includes(status) &&
    (data.intended_plan ?? data.plan)?.recurring &&
    !data.subscription.paygate_auto_renew
  ) {
    return "not renewing"
  } else {
    return status
  }
}

// The current plan and billing cycle.
async function plan(options: OutputOptions): Promise<void> {
  const data = await apiJson(`${BILLING_API}/subscription`)
  output(options, data, () => {
    // A negative balance is credit in the account's favour.
    const creditCents = Math.max(0, -(data.subscription?.paygate_balance_cents || 0))
    printRows(
      ["PLAN", "STATUS", "COMPUTE-UNITS", "TRIAL-HOURS/MONTH", "CREDIT-USD", "CYCLE-END"],
      [[
        (data.intended_plan ?? data.plan)?.name,
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
  const account = program.command("account").description("show the account plan and quota")

  account
    .command("quota")
    .description("show what the account has used and may use")
    .option("--json", "print the API responses as JSON")
    .action(quota)

  account
    .command("plan")
    .description("show the current plan and billing cycle")
    .option("--json", "print the API response JSON")
    .action(plan)
}
