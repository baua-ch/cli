# @baua/cli

Deploy an app your CI has built to [baua](https://baua.ch).

```sh
BAUA_TOKEN=bdt_… deno run -A jsr:@baua/cli@0 deploy dist --runtime node@24
```

The CLI uploads the directory, prints the build log and exits with `0` once the app runs.

Install it as a `baua` command:

```sh
deno install -g -A -n baua jsr:@baua/cli@0
baua deploy dist --runtime node@24
```

## Options

| Option | |
| --- | --- |
| `--runtime` | `node@22`, `node@24`, `deno@2`, `dotnet@8`–`10`, `binary`, `static` |
| `--start` | start command (needed for `dotnet` and `binary`) |
| `--preview` | deploy a preview with this name |
| `--project` | `org/name`, only with an API token |

`BAUA_TOKEN` is your project's deploy token. Node.js 24 or Deno 2; no dependencies.

## Logs and errors

```sh
BAUA_TOKEN=baua_… baua logs --project acme/shop --follow
BAUA_TOKEN=baua_… baua errors --project acme/shop --since 7d --stack
```

`logs` prints the app's log lines (the newest 100, or `--since 1h`; `-f` keeps following). `errors` lists the exceptions your app reported through OpenTelemetry, grouped, with a link to the newest trace. Both read production, or a preview with `--preview <name>`, and need an API token (`baua_…`), not a deploy token. All commands: [console.baua.ch/docs/cli](https://console.baua.ch/docs/cli).

## GitHub Actions

```yaml
- uses: denoland/setup-deno@v2
- run: deno run -A jsr:@baua/cli@0 deploy dist --runtime node@24
  env:
    BAUA_TOKEN: ${{ secrets.BAUA_TOKEN }}
```

## Node.js without Deno

```sh
npm config set @jsr:registry https://npm.jsr.io
npm install --prefix ~/.baua @jsr/baua__cli@0
node ~/.baua/node_modules/@jsr/baua__cli/main.js deploy dist --runtime node@24
```

## Development

`npm install && npm test`. To release, raise the version in `jsr.json` and `main.ts`, then run the **publish** workflow.

MIT
