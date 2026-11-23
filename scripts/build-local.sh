set -eu

export PATH="$PATH:${BUN_INSTALL:-$HOME/.bun}/bin"
npm ci
npm run build
bun build src/index.ts --compile --outfile dist/hc

if pkg-config --exists ayatana-appindicator3-0.1; then
    go -C gui build -o ../dist/hc-gui .
else
    go -C gui build -tags legacy_appindicator -o ../dist/hc-gui .
fi
CGO_ENABLED=0 go -C proxy-helper build -tags with_utls -o ../dist/hc-proxy .
