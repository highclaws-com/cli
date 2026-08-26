# hc

HighClaws CLI.

## Usage

```sh
hc expose tcp:43817
hc expose http:8000
hc expose https:8443
hc --cloudflared-version 2026.7.0 expose tcp:43817
```

## Examples

### SSH

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

### OpenAI-compatible API

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
npm run dev -- <args>
npm run typecheck
npm run build
npm run bin:linux
npm run bin:mac
npm run bin:win
npm run bin:all
npm link
```

## Administration

`admin` is tied to a specific repo checkout. It discovers its configuration by
walking up from the current directory to the repo root that contains
`secrets/cli.json`, and reads environment values from `config.env` with
`secrets/config.env` overriding it. Run `admin` from anywhere inside that
checkout (or pass `--root <dir>` to point at one explicitly).
