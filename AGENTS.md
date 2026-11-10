# hc CLI — Agent Guide

> See [README.md](README.md) for the human-facing overview.

## Background

`hc` is driven by an agent on behalf of a non-technical user. `hc sandbox` and
`hc connector` commands that take `--json` print readable rows by default and
the HighClaws API JSON with `--json`; the other `hc sandbox` commands always
print JSON. `hc expose` and `hc sync` print the entrance/target they set up.

## Guidance

Run the commands yourself and act on their output; do not make the user use the
terminal unless a step below says so.

While the user waits on a simple question and you run several tool calls, send
one line about what you are doing, then keep going. When they wait on an answer —
not on finished work, and especially when they are waiting for your next
instruction — verify less: send the next immediate step even if you are not sure
it will work, and adjust after they report back. Instant help wins here.

## Install

If `hc` is not installed, download the binary for the platform from the
[latest release](https://github.com/highclaws-com/cli/releases/latest):

| Platform | File |
| --- | --- |
| Linux x64 | `hc-linux-x64` |
| Linux arm64 | `hc-linux-arm64` |
| macOS Intel | `hc-mac-x64` |
| macOS Apple silicon | `hc-mac-arm64` |
| Windows x64 | `hc-win.exe` |

Direct download:
`https://github.com/highclaws-com/cli/releases/download/latest/<file>`

On Linux and macOS, make it executable after downloading:

```sh
chmod +x <file>
```

## Login

There is no status command. Run any command that needs auth (for example
`hc sandbox ls`). If it fails with:

```
error: not logged in: run `hc auth login`
```

the user is not logged in.

You (the agent) run `hc auth login`; the user never has to touch the CLI. It
prints a login URL:

```
Open this URL in your browser:
https://highclaws.com/u/login?next=...
```

Relay that URL to the user, ask them to open it and log in, then have them give
you the login code it shows. Enter that code at the `Paste login code:` prompt.

Credentials are saved locally, so every later command works without the user.

`hc auth logout` removes the saved credentials.

## Sandbox discovery

List the user's sandboxes:

```sh
hc sandbox ls --json [--limit <n>] [--page <n>]     # defaults: limit 10, page 1
```

Output is the provision API JSON. The fields needed downstream:

- `provision_id`, `name`, `status`
- `ProvisionProxy_result.host` — the sandbox `*.highclaws.com` host (no scheme)
- `ProvisionProxy_result.upstream_ip` — the direct IP
- `mapped_ports.webdav`, `mapped_ports.rsync` — the public ports

`ProvisionProxy_result` may be a JSON string; parse it if so.

Inspect one sandbox (`<host>` is from above, with or without `https://`):

```sh
hc sandbox inspect <host>
```

Output is the manager overview JSON. The worktrees are `disks.disks[].name`.

Fetch the sync token for a sandbox:

```sh
hc sandbox get-sync-token <host>
```

Output: `{"status":"ok","token":"..."}`. The same token authenticates both WebDAV
and rsync.

## Sandbox management

`<id>` is the `provision_id` from `hc sandbox ls`. Commands that change a
sandbox wait until the change is applied, printing progress on stderr.

```sh
hc sandbox create <tier> <name> [--model <connector-id>] [--timezone <tz>] [--detach]
hc sandbox ls-recoverable
hc sandbox rm-recoverable <id> --force
hc sandbox create <tier> <name> --recover <id> [--restore-agents] [--restore-browser]
hc sandbox job <job-id> [--wait]
hc sandbox rm <id> --force
hc sandbox rename <id> <new-name>
hc sandbox usage <id>
hc sandbox ls-agents <id>
hc sandbox persona <id> <file> [--agent <profile>]
hc sandbox timezone <id> <tz>
```

`create --detach` returns at once with the job IDs to pass to `hc sandbox job`.
`rm` asks for confirmation unless `--force` is given.

`ls-recoverable` lists deleted sandboxes whose files were kept; `create --recover`
attaches one's files to the new sandbox, and the two restore options also
bring back its agents or browser backup when the list shows one.

`<tier>` is a TIER from `hc sandbox ls-tiers`, which also shows the units each
one costs. Before creating, check `hc account quota`: the tier's units must fit
in what is left of "compute units". `hc account plan` shows the account's email and join date, the current plan,
and any credit toward future subscriptions, and `hc account model-usage` the tokens used per model in this billing period.
`hc account redeem <code> --force` redeems an invite code; it restarts the
free trial hours from zero, so ask the user first.
`--agent` defaults to `default`.

Connectors (models, messaging apps, vaults) are saved once and then bound to
sandboxes:

```sh
hc connector ls models|free-models|ims|vaults [--limit <n>] [--page <n>]
hc connector schema models|ims|vaults
hc connector new models|ims|vaults --provider <provider> --name <name> \
  [--model <model-id>] [--key <field=value>]... [--key-file <json-file>]
hc connector new ims --provider Weixin --name <name> --qr <file>
hc connector rm models|ims|vaults <connector-id>
hc sandbox bind <id> agents|ims|vaults <agent-id>:<display name>=<id>,<id>
hc sandbox unbind <id> agents|ims|vaults <agent-id> [--force]
```

`connector schema` lists what the server accepts: each provider, its
`--auth-method`, and its fields with required ones starred. FIELDS map to
options (`model_id` is `--model`, `upstream_overwrite` is `--upstream`);
KEY-FIELDS are given with `--key`. Add `--json` for each field's pattern.
`connector new` passes the fields through as given; a missing or invalid field
is named in the error. `--key-file` supplies all fields from one
JSON file. `--qr` saves a QR code image to `<file>` and waits until the user
has scanned and confirmed it, so show that file to the user.

`bind` sets the agents it names and leaves every other agent as it is, so
running it again changes nothing. Every item has the same form,
`<agent-id>:<display name>=<id>,<id>`, and values go to the server as typed.

- `bind agents "agent-3f9c1a2b7d4e5f60:Research Lead=104"` sets that agent's
  display name and its one model connector; an empty name or ID means none.
  An agent that does not exist is created with that ID.
- `bind ims agent-3f9c1a2b7d4e5f60:=30,29` and
  `bind vaults agent-3f9c1a2b7d4e5f60:=2` set that agent's messaging apps or
  vaults to the connectors listed; the name part is left empty.
- `unbind agents agent-3f9c1a2b7d4e5f60` removes that agent with its data; it
  asks first unless `--force` is given. `unbind ims agent-3f9c1a2b7d4e5f60`
  and `unbind vaults agent-3f9c1a2b7d4e5f60` remove all of that agent's
  messaging apps or vaults.

`<agent-id>` is the AGENT column of `hc sandbox ls-agents <id>`, which also shows
each agent's current name and model, and is the value `--agent` takes in
`persona` and `msg`.

## Message the sandbox agent

Anything the sandbox agent manages itself (scheduled jobs, files, its browser)
is done by asking it. `<host>` is the HOST column from `hc sandbox ls`.

```sh
hc sandbox msg <host> "<message>" [--agent <profile>] [--conversation <key>] [--no-toolcall-print]
```

The reply is printed as it arrives, followed by `conversation: <key>`. Each
call starts a new conversation unless that key is passed back with
`--conversation`. Each tool call is printed too, on stderr, as
`> <tool> <arguments>` with its result as `< <result>`; `--no-toolcall-print`
leaves them out. With `--json` the output is `{"conversation", "text",
"activity"}`.

The agent cannot reach the backup of the sandbox's files, so use the CLI for
it. It prints the last backup's start and finish times, starts one now, or
lists a folder of the backup:

```sh
hc sandbox file-backup <host> [--trigger]
hc sandbox file-backup <host> --list <dir> [--page <n>]
```

To rotate the file sync token or the Safe Connect access code, ask the agent
through `msg`; it does both through its sandbox management API. Then read the
new value with `hc sandbox get-sync-token` or `hc sandbox get-endpoint`.

If the agent does not answer, restart it, then send the message again:

```sh
hc sandbox restart <host>
```

## Sync (WebDAV mount and rsync)

Mounting needs a one-time OS-specific prerequisite (WinFsp on Windows, macFUSE
on macOS); see [README.md](README.md) (Windows setup / macOS setup).

Mount a worktree over WebDAV (via rclone):

```sh
hc sync --token <token> mount https://<host>/webdav/<worktree> <mountpoint>
```

rsync a worktree:

```sh
hc sync --token <token> rsync -ar \
  rsync://rsync@<upstream_ip>:<mapped_ports.rsync>/data/<worktree> <local-dir>
```

Notes:

- `<token>` is the `token` from `hc sandbox get-sync-token`.
- To stop repeating `--token`, save it once as the default:
  `hc sync --token <token>` (no subcommand). Later `mount`/`rsync` reuse it.
- `mount` runs in the foreground; Ctrl+C unmounts.
- Mounts cache reads by default (`--vfs-cache-mode full`, cache under
  `<user-cache>/highclaws/rclone/cache`); override with
  `hc sync mount --vfs-cache-mode <off|minimal|writes|full>`.

### Example — mount a worktree

1. `hc sandbox ls --json` → pick the sandbox; read `ProvisionProxy_result.host`.
2. `hc sandbox inspect <host>` → pick a worktree from `disks.disks[].name`.
3. `hc sandbox get-sync-token <host>` → read `token`.
4. `hc sync --token <token> mount https://<host>/webdav/<worktree> <mountpoint>`

## Expose a local service

`hc expose` publishes a local service through a Cloudflare Quick Tunnel. The
service must already be listening on `127.0.0.1:<port>` (to expose SSH, enable
an SSH server first — see [README.md](README.md) for per-platform steps).

```sh
hc expose tcp:<port>
hc expose http:<port>
hc expose https:<port>
```

It prints the public entrance:

- `http`/`https`: `Entrance: https://<random>.trycloudflare.com` — the remote
  side uses this URL directly.
- `tcp`: `Entrance: tcp://<random>.trycloudflare.com?port=<port>` — the remote
  side must first bridge it, then talk to the local port:
  ```sh
  cloudflared access tcp --hostname <random>.trycloudflare.com --url 127.0.0.1:<local-port>
  # then connect to 127.0.0.1:<local-port>
  ```

Read the `Entrance:` line from the command's output. Nothing registers it
anywhere and it changes on every run, so the cloud agent cannot discover it:
give the entrance to the user and tell them to message it to the cloud agent so
it can reach the exposed local service. `hc expose` runs in the foreground;
Ctrl+C stops it.

## Connect a computer

`hc safe-expose` lets the sandbox reach this computer's SSH server on port 22.
`ENDPOINT` is printed by `hc sandbox get-endpoint <id>` (`<id>` is the
`provision_id` from `hc sandbox ls`); it is a secret. It is saved
after the first successful connection, so later runs need no argument. It
runs in the foreground; Ctrl+C stops it.

```sh
hc safe-expose ENDPOINT
hc safe-expose
```

Port 2222 inside the sandbox reaches port 22 on this computer.

`hc safe-forward` goes the other way: it forwards a local port to the TCP
service the cloud agent runs on the sandbox's private port, whatever protocol
it speaks. `ENDPOINT` is the same value; it is saved when passed, so later
runs need no argument. It runs in the foreground; Ctrl+C stops it.

```sh
hc safe-forward 1080 ENDPOINT
hc safe-forward 1080
```

Clients on this computer then connect to `127.0.0.1:1080`.

From inside the sandbox:

```sh
SSHPASS=your-password
SSH_USER=your-user
sshpass -e ssh \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=accept-new \
  -p 2222 "$SSH_USER"@localhost \
  'pwd'
```

## Browser egress

Running `hc proxy` gives the cloud-side agent browser a SOCKS5 egress through the
machine running it, changing that browser's public IP to that machine's so it
better matches sites' geographic fingerprint expectations. It prints a **Client
WireGuard Public Key** and then runs in the foreground — keep it running.

Egress needs two independent states **both** on:

- **Connection** — the WireGuard peer is registered and reachable. Read it with
  `hc sandbox egress get <host>`: `wg_remote_public_key` must be set and
  `healthy` must be true.
- **Switch** — the sandbox is told to use the egress. Read it with
  `hc sandbox egress get <host> --switch-status`: `enabled` must be true.

They are separate because the peer can be connected while the switch is off (and
vice versa); if the switch is on but the connection is not healthy, egress still
fails. Turn on both.

### Enable

`hc proxy` needs two inputs, which it prompts for and saves (later runs do not
prompt):

- **Endpoint** = `<upstream_ip>:<mapped_ports.wireguard>` from `hc sandbox ls --json`.
  `upstream_ip` is inside `ProvisionProxy_result`, which may be a JSON string —
  parse it.
- **Sandbox WireGuard Public Key** = `wg_local_public_key` from
  `hc sandbox egress get <host>`.

Start the proxy first — it prints the **Client WireGuard Public Key** and then
blocks in the foreground, so run it in a terminal (or background it and read the
key from its output) and keep it running:

```sh
hc proxy
```

While it runs, register that client key and turn the switch on in one call:

```sh
hc sandbox egress set <host> on --public-key <client-public-key>
hc sandbox egress get <host>                    # healthy: true
hc sandbox egress get <host> --switch-status    # enabled: true
```

`set on --public-key` registers the peer *and* flips the switch; the registration
waits for the peer to become healthy, so the proxy must already be up. The client
key is stable across runs; `hc proxy --reset` generates a new one.

### Disable

```sh
hc sandbox egress set <host> off
# stop hc proxy (Ctrl+C, or SIGTERM its PID); this also stops its child helper
```

If `hc proxy` stops, `healthy` becomes false even though the switch stays on.

All `hc sandbox egress` output is the raw JSON.
