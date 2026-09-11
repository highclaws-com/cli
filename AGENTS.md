# hc CLI — Agent Guide

> See [README.md](README.md) for the human-facing overview.

`hc` is driven by an agent on behalf of a non-technical user. Run the commands
yourself and act on their output; do not make the user use the terminal unless a
step below says so.

`hc sandbox ...` prints the raw HighClaws JSON. `hc expose` and `hc sync` print
the entrance/target they set up.

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
hc sandbox ls [--limit <n>] [--page <n>]     # defaults: limit 10, page 0
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

1. `hc sandbox ls` → pick the sandbox; read `ProvisionProxy_result.host`.
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

- **Endpoint** = `<upstream_ip>:<mapped_ports.wireguard>` from `hc sandbox ls`.
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
