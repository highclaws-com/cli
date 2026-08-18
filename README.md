# cli

The CLI source code for highclaws command-line use or admin operations.

## Dev / build

Run all of the following in this directory (requires Node.js >= 18):

```sh
npm install             # install dependencies
npm run dev -- <args>   # dev loop: bundle, then run with args
                        # e.g. npm run dev -- admin db --entrypoint
npm run typecheck       # tsc --noEmit
npm run build           # bundle everything into dist/cli.js (run with node)
npm run bin:linux       # standalone binaries -> bin/ (linux, mac, win, or all)
npm run bin:mac
npm run bin:win
npm run bin:all
npm link                # expose `hc` as a global command for local use
```

## Administration

`admin` is tied to a specific repo checkout. It discovers its configuration by
walking up from the current directory to the repo root that contains
`secrets/cli.json`, and reads environment values from `config.env` with
`secrets/config.env` overriding it. Run `admin` from anywhere inside that
checkout (or pass `--root <dir>` to point at one explicitly).
