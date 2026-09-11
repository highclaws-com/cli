# hc CLI — Agent Guide

> See [README.md](README.md) for the human-facing overview.

`hc` is driven by an agent on behalf of a non-technical user. Run the commands
yourself and act on their output; do not make the user use the terminal unless a
step below says so.

`hc sandbox ...` prints the raw HighClaws JSON. `hc expose` and `hc sync` print
the entrance/target they set up. `hc proxy` is not covered here yet.

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

the user is not logged in. Login is interactive and needs the user:

1. Run `hc auth login`. It prints a login URL:
   ```
   Open this URL in your browser:
   https://highclaws.com/u/login?next=...
   ```
2. Ask the user to open that link, log in, and copy the login code it shows.
3. Enter that code at the `Paste login code:` prompt.

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
- One-time mount prerequisites: Windows needs WinFsp
  (`winget install WinFsp.WinFsp`), macOS needs macFUSE
  ([macfuse.io](https://macfuse.io/)). rclone (and, on Windows, rsync) download
  automatically on first use.

## Expose a local service

```sh
hc expose tcp:<port>
hc expose http:<port>
hc expose https:<port>
```

Starts a Cloudflare Quick Tunnel to `127.0.0.1:<port>` and prints the public
entrance:

- `http`/`https`: `Entrance: https://<random>.trycloudflare.com`
- `tcp`: `Entrance: tcp://<random>.trycloudflare.com?port=<port>`

Nothing registers this entrance anywhere and it changes on every run, so the
remote (cloud) agent cannot discover it. The user must pass the printed
`Entrance:` value to the cloud agent for it to reach the exposed local service.
Runs in the foreground; Ctrl+C stops it.

## Worked example — "mount my sandbox files"

1. `hc sandbox ls` → pick the sandbox; read `ProvisionProxy_result.host`.
2. `hc sandbox inspect <host>` → pick a worktree from `disks.disks[].name`.
3. `hc sandbox get-sync-token <host>` → read `token`.
4. `hc sync --token <token> mount https://<host>/webdav/<worktree> <mountpoint>`
