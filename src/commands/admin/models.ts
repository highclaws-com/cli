import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { Command } from "commander"
import diff from "microdiff"
import { AdminContext, extractEnv } from "../../config"
import { escapeShell, run, runCapture, SSH_OPTS } from "../../exec"
import { swarmExec } from "../../swarm-exec"

interface ModelsOptions {
  contextLength?: boolean
  price?: boolean
  pool?: boolean
  allowlist?: boolean
}

// Request counts a model pool replica keeps in memory per credential or
// provider key; `recent_requests` holds 20 buckets of 10 minutes, oldest first.
// `priority` is the selection priority (higher is tried first, unset is 0).
interface RequestCounts {
  success: number
  failed: number
  disabled?: boolean
  priority?: number
  cooling?: boolean
  retry?: number
  // Stable CPA auth ID, set for OpenAI-compatible provider keys so their
  // persisted cooldown rows can be matched against this row.
  authId?: string
  recent_requests: { success: number; failed: number }[]
}

// One provider key in a model pool config section.
type KeyEntry = {
  "api-key": string
  "base-url"?: string
  "proxy-url"?: string
  "disable-cooling"?: boolean
  "request-retry"?: number
  priority?: number
}

export function registerModels(admin: Command, getCtx: () => AdminContext): void {
  const models = admin
    .command("models")
    .description("inspect model configuration")
    .option("--context-length", "display the public model context lengths from the live connector service")
    .option("--price", "display model prices from the live billing service")
    .option("--pool", "display models available from the live model-pool service")
    .option("--allowlist", "display the admin (uid=1) model rows the model-pool allowlist is built from, including hidden ones")
    .action(async (opts: ModelsOptions) => {
      if (!opts.contextLength && !opts.price && !opts.pool && !opts.allowlist) {
        models.outputHelp()
        return
      }

      const { root, adminConfig, env } = getCtx()
      if (!adminConfig.domain) {
        throw new Error("no 'domain' key in secrets/cli.json")
      }

      if (opts.contextLength) {
        const url = `https://${adminConfig.domain}/connectors/public/model-context`
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error(`request failed: HTTP ${res.status} ${res.statusText}`)
        }
        const body = await res.text()
        let pretty = body
        try {
          pretty = JSON.stringify(JSON.parse(body), null, 2)
        } catch {
          // not JSON; display raw
        }
        console.log(pretty)
      }

      if (opts.price) {
        const { code, stdout } = await swarmExec(getCtx(), "billing", "cat /app/model_pricing.json")
        if (code !== 0) {
          throw new Error(`price fetch failed (exit ${code})`)
        }
        let pretty = stdout
        try {
          pretty = JSON.stringify(JSON.parse(stdout), null, 2)
        } catch {
          // not JSON; display raw
        }
        console.log(pretty)
      }

      if (opts.pool) {
        // the model pool management password is derived from GATEWAY_VIEWER_KEY (config.env)
        const [managementKey] = extractEnv(env, ["GATEWAY_VIEWER_KEY"])
        const baseUrl = `https://model-pool.${adminConfig.domain}`
        const keysRes = await fetch(`${baseUrl}/v0/management/api-keys`, {
          headers: { "X-Management-Key": managementKey }
        })
        if (!keysRes.ok) {
          throw new Error(`request failed: HTTP ${keysRes.status} ${keysRes.statusText}`)
        }
        const keysBody = await keysRes.json() as { "api-keys"?: string[] }
        const apiKey = keysBody["api-keys"]?.[0]
        if (!apiKey) {
          throw new Error("model pool has no API keys configured")
        }
        const modelsRes = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        })
        if (!modelsRes.ok) {
          throw new Error(`request failed: HTTP ${modelsRes.status} ${modelsRes.statusText}`)
        }
        const body = await modelsRes.text()
        let pretty = body
        try {
          pretty = JSON.stringify(JSON.parse(body), null, 2)
        } catch {
          // not JSON; display raw
        }
        console.log(pretty)
      }

      if (opts.allowlist) {
        const target = adminConfig.db
        if (!target) {
          throw new Error("no 'db' entry in secrets/cli.json")
        }
        const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
        const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
        // The gateway allows every model_id below; a "_" name prefix
        // (e.g. "_foo") only hides the row from the free_models list.
        const sql = `
          SELECT name, model_id, created_at
          FROM "Models"
          WHERE user_uid = 1
          ORDER BY model_id, name;
        `
        const remote = `docker exec db_1-db-1 psql -v ON_ERROR_STOP=1 -X -q` +
          ` -d ${escapeShell(sqlLink)} -c ${escapeShell(sql)}`
        const { code, stdout } = await runCapture(
          "ssh", [
            ...SSH_OPTS,
            "-i", path.join(root, target.ssh_key), `${target.ssh_usr}@${target.ip}`, remote
          ]
        )
        if (code !== 0) {
          throw new Error(`allowlist query failed (exit ${code})`)
        }
        console.log(stdout.trimEnd())
      }
    })

  models
    .command("scan")
    .description("scan model rows on the db node; extra args pass through to the script")
    .option("--remote-root <dir>", "source root on the db node", "~/highclaws-core")
    .argument("[extra ...]")
    .allowUnknownOption()
    .helpOption(false)
    .action(async (extra: string[], opts: { remoteRoot: string }) => {
      const { root, adminConfig, env } = getCtx()
      const target = adminConfig.db
      if (!target) {
        throw new Error("no 'db' entry in secrets/cli.json")
      }
      const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
      const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db`
      const key = path.join(root, target.ssh_key)
      const at = `${target.ssh_usr}@${target.ip}`
      const help = extra.some((arg) => arg === "-h" || arg === "--help")
      const extras = extra.map(escapeShell).join(" ")
      const common = [
        `cd ${opts.remoteRoot}`,
        `export PATH="$HOME/.local/bin:$PATH"`
      ]
      const rest = help
        ? ["uv run scripts/db_scan_models.py -h"]
        : [
          `{ command -v uv >/dev/null 2>&1 || { wget -qO /tmp/uv-install.sh https://astral.sh/uv/install.sh && sh /tmp/uv-install.sh; }; }`,
          "git fetch --depth=1 origin deploy",
          "git checkout -B deploy origin/deploy",
          "git submodule update --init app/sandbox_model_proxy",
          `uv run scripts/db_scan_models.py ${escapeShell(sqlLink)}${extras ? " " + extras : ""}`
        ]
      const remote = [...common, ...rest].join(" && ")
      console.log(`[models scan] db node ${target.ip}, remote root ${opts.remoteRoot}`)
      const rc = await run("ssh", [
        ...SSH_OPTS,
        "-i", key, at, remote
      ])
      if (rc !== 0) {
        throw new Error(`models scan failed (exit ${rc})`)
      }
    })

  models
    .command("issue-manual-key")
    .description("issue a model pool key not bound to any sandbox, billed to <uid>")
    .argument("<uid>", "user id with an active subscription")
    .action(async (uidArg: string) => {
      const uid = Number(uidArg)
      if (!Number.isInteger(uid) || uid <= 0) {
        throw new Error(`invalid uid: ${uidArg}`)
      }
      const { root, adminConfig, env } = getCtx()
      const target = adminConfig.db
      if (!target) {
        throw new Error("no 'db' entry in secrets/cli.json")
      }
      const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
      const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
      const sshKey = path.join(root, target.ssh_key)
      const apiKey = `vk-${randomBytes(32).toString("base64url")}`
      // Unique per manual key, e.g. `manual-3f9a1c0b7e2d4a56`, so the
      // one-unrevoked-key-per-(user_uid, provision_id) index allows many
      // manual keys per user.
      const provisionId = `manual-${randomBytes(8).toString("hex")}`
      // Only a subscriber is billed and capped, and billing revokes the key
      // when the subscription ends.
      const sql = `
        INSERT INTO "ModelKeys" (user_uid, provision_id, api_key)
        SELECT uid, '${provisionId}', '${apiKey}'
        FROM "BillingSubs"
        WHERE uid = ${uid}
          AND paygate_status IN ('active', 'trialing', 'past_due')
        RETURNING api_key;
      `
      const remote = `docker exec db_1-db-1 psql -v ON_ERROR_STOP=1 -X -q -A -t` +
        ` -d ${escapeShell(sqlLink)} -c ${escapeShell(sql)}`
      const { code, stdout } = await runCapture(
        "ssh", [
          ...SSH_OPTS,
          "-i", sshKey, `${target.ssh_usr}@${target.ip}`, remote
        ]
      )
      if (code !== 0) {
        throw new Error(`manual key insert failed (exit ${code})`)
      }
      if (!stdout.trim()) {
        throw new Error(`uid ${uid} has no active subscription`)
      }
      console.log(stdout.trim())
    })

  models
    .command("revoke-manual-key")
    .description("revoke the manual model pool key with row <id>")
    .argument("<id>", "ModelKeys row id")
    .action(async (id: string) => {
      const { root, adminConfig, env } = getCtx()
      const target = adminConfig.db!
      const [dbUser, dbPass] = extractEnv(env, ["DB_USER", "DB_PASS"])
      const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
      const sql = `UPDATE "ModelKeys" SET revoked_at = now() WHERE id = ${id};`
      const remote = `docker exec db_1-db-1 psql -d ${escapeShell(sqlLink)} -c ${escapeShell(sql)}`
      await run("ssh", [
        ...SSH_OPTS,
        "-i", path.join(root, target.ssh_key), `${target.ssh_usr}@${target.ip}`, remote
      ])
    })

  models
    .command("monitor-pool-replicas")
    .description("show each model pool credential and provider key per replica with calls, priority, and effective cooling")
    .action(async () => {
      const { env, adminConfig } = getCtx()
      // the model pool management password is derived from GATEWAY_VIEWER_KEY (config.env)
      const [managementKey] = extractEnv(env, ["GATEWAY_VIEWER_KEY"])
      const pools = adminConfig.model_pools
      if (!pools?.length) {
        throw new Error("no 'model_pools' entry in secrets/cli.json")
      }
      // The public host always reaches the same replica, so ask every replica
      // IP of every pool from inside the gateway container, one line per
      // answer, e.g. "model_pool 10.0.2.75 auth-files {...}".
      const header = escapeShell(`X-Management-Key: ${managementKey}`)
      const script =
        `for p in ${pools.map(escapeShell).join(" ")}; do` +
        " for ip in $(getent hosts tasks.$p | cut -d' ' -f1 | sort -u); do" +
        " for e in config auth-files api-key-usage; do" +
        ` printf '%s %s %s %s\\n' $p $ip $e "$(curl -sSf -m 10 -H ${header} http://$ip:8317/v0/management/$e)";` +
        " done; done; done"
      const { code, stdout } = await swarmExec(getCtx(), "gateway", `sh -c ${escapeShell(script)}`)
      if (code !== 0) {
        throw new Error(`model pool replica query failed (exit ${code})`)
      }

      console.log([
        "cell: [priority] [*enabled|#cooling] ok/total +retry | missing | disabled",
        "bar: 10 min/char, oldest first; . none, + ok, x fail"
      ].join("\n"))
      const lines = stdout.trim().split("\n")
      for (const pool of pools) {
        const cooling = await activeCooldownAuthIds(getCtx(), pool)
        printPool(
          pool,
          lines.filter((l) => l.startsWith(`${pool} `)).map((l) => l.slice(pool.length + 1)),
          cooling
        )
      }
    })
}

// Prints one pool's table from its answer lines, e.g. "10.0.2.75 config {...}".
function printPool(pool: string, lines: string[], coolingAuthIds: Set<string>): void {
  // Per credential or provider key, e.g. "command code goat user_4…rNsV"
  // (provider keys masked), the counts each replica IP holds for it.
  const rows: Record<string, Record<string, RequestCounts>> = {}
  // Provider-key settings per replica IP, keyed "<provider>|<base url>|<api key>"
  // like the api-key-usage rows, e.g. settings["10.0.2.75"]["gemini||sk-e8F..."].
  const settings: Record<string, Record<string, Pick<RequestCounts, "priority" | "cooling" | "retry" | "authId">>> = {}
  // Config per replica IP without "api-keys", which billing pushes to each
  // replica on its own schedule, e.g. configs["10.0.2.75"] = { routing: {...}, ... }.
  const configs: Record<string, Record<string, unknown>> = {}
  for (const line of lines) {
    const [ip, endpoint, ...json] = line.split(" ")
    const body = JSON.parse(json.join(" "))
    if (endpoint === "config") {
      const { "api-keys": _, ...config } = body
      configs[ip] = config
      // CPA's StableIDGenerator counts duplicate IDs per kind+hash within one
      // replica's synthesis pass, so mirror that separately for each replica.
      const authIdCounts = new Map<string, number>()
      // "<provider>-api-key" lists, e.g. "gemini-api-key" -> provider "gemini",
      // and each OpenAI-compatible group as a provider named after the group.
      settings[ip] = Object.fromEntries([
        ...Object.keys(body)
          .filter((s) => s.endsWith("-api-key"))
          .flatMap((s) =>
            (body[s] ?? []).map((e: KeyEntry) => [
              `${s.replace(/-api-key$/, "")}|${e["base-url"] ?? ""}|${e["api-key"]}`,
              {
                priority: e.priority,
                retry: e["request-retry"],
                cooling: !(e["disable-cooling"] ?? body["disable-cooling"])
              }
            ])
          ),
        ...(body["openai-compatibility"] ?? []).flatMap(
          (g: KeyEntry & { name: string; "api-key-entries": KeyEntry[] | null }) =>
            (g["api-key-entries"] ?? []).map((e) => [
              `${g.name.toLowerCase()}|${g["base-url"] ?? ""}|${e["api-key"]}`,
              {
                priority: g.priority,
                retry: g["request-retry"],
                cooling: !(g["disable-cooling"] ?? body["disable-cooling"]),
                authId: openAICompatAuthId(g.name, g["base-url"] ?? "", e["api-key"], e["proxy-url"] ?? "", authIdCounts)
              }
            ])
        )
      ])
    } else {
      const entries: [string, RequestCounts][] = endpoint === "auth-files"
        ? body.files.map((f: RequestCounts & { name: string }) => [f.name, f])
        : Object.entries(body as Record<string, Record<string, RequestCounts>>).flatMap(
          ([provider, keys]) => Object.entries(keys).map(([baseUrlAndKey, counts]) => {
            const key = baseUrlAndKey.split("|").pop()!
            return [
              `${provider} ${key.slice(0, 6)}…${key.slice(-4)}`,
              { ...counts, ...settings[ip][`${provider}|${baseUrlAndKey}`] }
            ]
          })
        )
      for (const [name, counts] of entries) {
        rows[name] = { ...rows[name], [ip]: counts }
      }
    }
  }
  // Each replica answers config first, so its IP is a settings key.
  const ips = Object.keys(settings)

  const names = Object.keys(rows).sort()
  const width = Math.max(...names.map((n) => n.length)) + 2
  // Width of the widest "[priority]", e.g. "[10]", so the counts after it align.
  const priorityWidth = Math.max(...Object.values(rows).flatMap(
    (perReplica) => Object.values(perReplica).map((c) => `[${c.priority ?? 0}]`.length)
  ))
  // Per other replica, the top-level config fields that differ from the first
  // replica's, e.g. "10.0.2.126 vs 10.0.2.124: routing, payload".
  const diverged = ips.slice(1).flatMap((ip) => {
    const fields = [...new Set(diff(configs[ips[0]], configs[ip]).map((d) => d.path[0]))]
    return fields.length > 0 ? [`${ip} vs ${ips[0]}: ${fields.join(", ")}`] : []
  })
  // Config state after the pool name, e.g. "config all sync" or
  // "config diverged: 10.0.2.126 vs 10.0.2.124: routing; 10.0.2.127 vs ...".
  const configState = diverged.length > 0
    ? `config diverged: ${diverged.join("; ")}`
    : "config all sync"
  console.log([
    "",
    `[ ${pool} ] ${configState}`,
    "NAME".padEnd(width) + ips.map((ip) => ip.padEnd(24)).join("") + "LAST 200 MIN"
  ].join("\n"))
  console.log("global_cooling".padEnd(width) + ips.map((ip) =>
    (configs[ip]["disable-cooling"] ? "off" : "on").padEnd(24)
  ).join(""))
  console.log("global_retry".padEnd(width) + ips.map((ip) =>
    String(configs[ip]["request-retry"] ?? 0).padEnd(24)
  ).join(""))
  for (const name of names) {
    const cells = ips.map((ip) => {
      const c = rows[name][ip]
      const retry = c?.retry !== undefined && c.retry >= 0
        ? c.retry
        : configs[ip]["request-retry"] ?? 0
      const coolingNow = c?.authId !== undefined && coolingAuthIds.has(c.authId)
      const cell = !c ? "missing"
        : c.disabled ? "disabled"
          : `${`[${c.priority ?? 0}]`.padEnd(priorityWidth)} ` +
             `${coolingNow ? "#" : c.cooling ? "*" : " "} ${c.success}/${c.success + c.failed} +${retry}`
      return cell.padEnd(24)
    })
    const all = Object.values(rows[name])
    const bar = all[0].recent_requests.map((_, b) =>
      all.some((c) => c.recent_requests[b].failed > 0) ? "x"
        : all.some((c) => c.recent_requests[b].success > 0) ? "+" : "."
    ).join("")
    console.log(name.padEnd(width) + cells.join("") + bar)
  }
}

// activeCooldownAuthIds returns the auth IDs with an unexpired persisted
// cooldown for a pool, read from its PostgreSQL cooldown_store table. Returns
// an empty set when the DB target or credentials are unavailable, or the
// store does not exist or cannot be read.
async function activeCooldownAuthIds(ctx: AdminContext, pool: string): Promise<Set<string>> {
  const none = new Set<string>()
  const target = ctx.adminConfig.db
  if (!target || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pool)) return none
  const dbUser = ctx.env.DB_USER
  const dbPass = ctx.env.DB_PASS
  if (!dbUser || !dbPass) return none
  const sqlLink = `postgresql://${dbUser}:${dbPass}@${target.container}:5432/backend_db?sslmode=disable`
  const sql = `SELECT auth_id FROM "${pool}".cooldown_store ` +
    `WHERE NOT deleted AND (content->>'next_retry_after')::timestamptz > now();`
  const remote = `docker exec db_1-db-1 psql -v ON_ERROR_STOP=1 -X -q -A -t ` +
    `-d ${escapeShell(sqlLink)} -c ${escapeShell(sql)} 2>/dev/null`
  const { code, stdout } = await runCapture("ssh", [
    ...SSH_OPTS,
    "-i", path.join(ctx.root, target.ssh_key),
    `${target.ssh_usr}@${target.ip}`,
    remote
  ])
  if (code !== 0) return none
  return new Set(stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0))
}

// openAICompatAuthId mirrors CPA's StableIDGenerator for an
// openai-compatibility key: kind + NUL + api key + NUL + base URL + NUL +
// proxy URL, SHA-256, first 12 hex chars, with the duplicate suffix CPA adds.
function openAICompatAuthId(
  name: string,
  baseUrl: string,
  apiKey: string,
  proxyUrl: string,
  counts: Map<string, number>
): string {
  const provider = name.trim().toLowerCase() || "openai-compatibility"
  const kind = `openai-compatibility:${provider}`
  const hasher = createHash("sha256").update(kind)
  for (const part of [apiKey, baseUrl, proxyUrl]) {
    hasher.update("\0").update(part.trim())
  }
  let short = hasher.digest("hex").slice(0, 12)
  const counterKey = `${kind}:${short}`
  const index = counts.get(counterKey) ?? 0
  counts.set(counterKey, index + 1)
  if (index > 0) short = `${short}-${index}`
  return `${kind}:${short}`
}
