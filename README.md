# hc

HighClaws CLI: A CLI tool for exposing your local machine to HighClaws sandboxes, syncing files, and proxying cloud browser egress, etc.

## Usage

```sh
# log in and save the platform JWT
hc auth login
# remove the saved credentials
hc auth logout
# route sandbox browser egress through this computer
hc proxy
# expose a local TCP service through Cloudflare
hc expose tcp:43817
# expose a local HTTP service through Cloudflare
hc expose http:8000
# expose a local HTTPS service through Cloudflare
hc expose https:8443
# mount a sandbox WebDAV tree
hc sync --token <token> mount https://<host>/webdav/<worktree> ./dir
# sync files with rsync
hc sync --token <token> rsync -ar rsync://rsync@<host>:<port>/data/<worktree> ./dir
```

## Windows setup

### Mount (WinFsp)

`hc sync mount` uses rclone, which mounts through WinFsp on Windows. Install it
once (admin); mounting then runs as a normal user.

```powershell
winget install WinFsp.WinFsp
```

Or download the MSI from <https://winfsp.dev/rel/>.

## macOS setup

### Mount (macFUSE)

`hc sync mount` uses rclone, which mounts through macFUSE on macOS. Install it
once from <https://macfuse.io/>.

## Examples

### Linux SSH server

Expose:

```sh
hc expose tcp:22
```

Proxy:

```sh
TUNNEL_HOSTNAME=your-tunnel.trycloudflare.com
cloudflared access tcp \
  --hostname "$TUNNEL_HOSTNAME" \
  --url 127.0.0.1:2222
```

```sh
SSH_PASSWORD=your-password
SSH_USER=your-user
sshpass -p "$SSH_PASSWORD" ssh \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -p 2222 "$SSH_USER"@localhost \
  'pwd'
```

### macOS SSH server

Enable Remote Login: **Apple Menu > System Settings > General > Sharing**, then
toggle on **Remote Login**.

Test locally:

```sh
ssh "$(whoami)"@localhost
```

### Windows SSH server

Admin PowerShell:

```powershell
# 1. install OpenSSH Server
# reset sources to avoid the msstore source stalling the install
winget source reset --force
winget source update
winget install "OpenSSH Preview" --source winget

# 2. start sshd and enable it at boot
Start-Service sshd
Set-Service sshd -StartupType Automatic

# 3. create a dedicated user with a password
net user sshagent * /add

# optional: grant admin rights
net localgroup Administrators sshagent /add

# 4. test SSH locally
ssh sshagent@localhost
```

If step 4 fails, check:

```powershell
Get-Service sshd
Test-NetConnection localhost -Port 22
```

### Exposing a local model

Token:

```sh
TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
printf 'API token: %s\n' "$TOKEN"
```

Serve:

```sh
docker run --rm -it \
  --name sglang-qwen38 \
  --gpus all \
  --ipc host \
  -p 127.0.0.1:30000:30000 \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  lmsysorg/sglang:qwen38-27b \
  python3 -m sglang.launch_server \
  --host 0.0.0.0 \
  --port 30000 \
  --api-key "$TOKEN" \
  --tp 4 \
  --mem-fraction-static 0.95 \
  --attention-backend flashinfer \
  --cuda-graph-max-bs-decode 2 \
  --max-running-requests 2 \
  --max-total-tokens 262144 \
  --prefill-max-requests 2 \
  --chunked-prefill-size 2048 \
  --model-path Qwen/Qwen3.8-27B-FP8 \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen3_coder \
  --quantization fp8 \
  --kv-cache-dtype fp8_e5m2 \
  --context-length 262144 \
  --max-mamba-cache-size 20 \
  --speculative-algo NEXTN \
  --speculative-num-steps 3 \
  --speculative-eagle-topk 1 \
  --speculative-num-draft-tokens 4 \
  --allow-auto-truncate \
  --disable-fast-image-processor \
  --limit-mm-data-per-request '{"image":1}' \
  --mm-process-config '{"image":{"max_pixels":40000}}'
```

Expose:

```sh
hc expose http:30000
```

Test locally:

```sh
curl http://127.0.0.1:30000/v1/models \
  -H "Authorization: Bearer $TOKEN"
```

Test remotely:

```sh
URL=https://random-words.trycloudflare.com
curl "$URL/v1/models" \
  -H "Authorization: Bearer $TOKEN"
```

## Development

Requires Node.js >= 18.

```sh
npm install
npm run build
npm link
hc <command>
```

After source changes:

```sh
npm run build
hc <command>
```

Build standalone binaries:

```sh
npm run bin:all
```

## Administration

`admin` is tied to a specific repo checkout. It discovers its configuration by
walking up from the current directory to the repo root that contains
`secrets/cli.json`, and reads environment values from `config.env` with
`secrets/config.env` overriding it. Run `admin` from anywhere inside that
checkout (or pass `--root <dir>` to point at one explicitly).
