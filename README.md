# @baua/cli

Deploy an app that your CI has already built to [baua](https://baua.ch): `baua deploy` packs a directory, uploads it with its runtime and start command, prints the build log and exits with `0` once the deployment runs.

```sh
baua deploy <dir> --runtime <runtime> [--start <command>] [--preview <name>] [--project <org>/<name>]
```

- `<dir>`: the directory to upload; its contents become the app's directory.
- `--runtime`: `node@22`, `node@24`, `deno@2`, `dotnet@8`, `dotnet@9`, `dotnet@10`, `binary` (a Linux x86-64 executable) or `static`.
- `--start`: the start command; defaults to `node index.js` (Node.js) and `deno run --allow-all main.ts` (Deno); required for `dotnet` (e.g. `./App` or `dotnet App.dll`) and `binary` (e.g. `./server`).
- `--preview <name>`: deploy a preview with this name instead of production, e.g. for a pull request.
- `--project <org>/<name>`: only needed with an API token; a deploy token knows its project.
- `BAUA_TOKEN` (required): a deploy token (`bdt_…`) of the project or an API token.
- `BAUA_URL`: the console, default `https://console.baua.ch`.

It has no dependencies and runs on Node.js 24 or Deno 2 (it packs with the system `tar`).

## Run it

```sh
# Deno
deno run -A jsr:@baua/cli@0 deploy out --runtime dotnet@10 --start ./App

# Node.js: JSR's npm registry, then run the installed script
npm config set @jsr:registry https://npm.jsr.io
npm install --prefix "$HOME/.baua-cli" @jsr/baua__cli@0
node "$HOME/.baua-cli/node_modules/@jsr/baua__cli/main.js" deploy out --runtime dotnet@10 --start ./App
```

## GitHub Actions

```yaml
name: deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-dotnet@v6
        with:
          dotnet-version: '10.0.x'
      - run: dotnet publish -c Release -o out
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno run -A jsr:@baua/cli@0 deploy out --runtime dotnet@10 --start ./App
        env:
          BAUA_TOKEN: ${{ secrets.BAUA_TOKEN }}
```

Store the deploy token as the repository secret `BAUA_TOKEN`.

## Development

```sh
npm install
npm test
```

Releases: raise `version` in `jsr.json` and `VERSION` in `main.ts` (a test checks they match), then run the **publish** workflow on `main`. It publishes to JSR with OIDC – no token is stored.

## License

MIT
