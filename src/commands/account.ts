import { Command } from "commander"
import { APP_DOMAIN } from "../config"
import { apiJson } from "../api"
import { OutputOptions, output, printRows } from "../output"

const BILLING_API = `https://${APP_DOMAIN}/billing/api/v1`
const PROVISION_API = `https://${APP_DOMAIN}/provision/api/v1`

// What the account has used and may use, one row per resource.
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
    (sum: number, row: any) => sum + row.vps_unit, 0
  )
  output(options, { vps, trial, storage, model, used_vps_units: usedVpsUnits }, () => {
    printRows(
      ["RESOURCE", "USED", "TOTAL"],
      [
        ["sandbox units", usedVpsUnits, vps.total_vps_units],
        [
          "trial hours",
          (trial.trial_used_seconds / 3600).toFixed(1),
          (trial.monthly_trial_seconds / 3600).toFixed(1)
        ],
        [
          "storage (USD)",
          (storage.used_s3_cents / 100).toFixed(2),
          (storage.total_quota_s3_cents / 100).toFixed(2)
        ],
        [
          "models (USD)",
          (model.used_microdollars / 1e6).toFixed(2),
          (model.quota_microdollars / 1e6).toFixed(2)
        ]
      ]
    )
  })
}

// The current plan and billing cycle.
async function plan(options: OutputOptions): Promise<void> {
  const data = await apiJson(`${BILLING_API}/subscription`)
  output(options, data, () => {
    printRows(
      ["PLAN", "QUANTITY", "STATUS", "CYCLE-END", "AUTO-RENEW"],
      [[
        (data.intended_plan ?? data.plan)?.name,
        data.subscription?.quantity,
        data.subscription?.paygate_status,
        data.subscription?.cycle_end,
        data.subscription?.paygate_auto_renew
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
