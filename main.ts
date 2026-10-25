#!/usr/bin/env node
/**
 * The baua CLI: `baua deploy <dir> --runtime <runtime>` uploads a directory that CI has built and follows the deployment until it runs (https://console.baua.ch/docs/deploy-from-ci);
 * `baua logs` prints an app's log lines and `baua errors` the exceptions it reported through OpenTelemetry; `baua env pull` writes an app's
 * environment variables to a .env file and `baua run` starts a local command with them (https://console.baua.ch/docs/cli).
 * Runs on Node.js 24 and Deno 2 without dependencies; packs with the system `tar`.
 *
 * @module
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Kept equal to jsr.json's version (a unit test checks it). */
export const VERSION = '0.3.0';

export const DEFAULT_URL = 'https://console.baua.ch';

export const RUNTIMES: readonly string[] = ['node@22', 'node@24', 'deno@2', 'dotnet@8', 'dotnet@9', 'dotnet@10', 'binary', 'static'];

export const POLL_MS = 2000;

/** One overall limit for build, start and health check; no flag (https://console.baua.ch/docs/deploy-from-ci). */
export const TIMEOUT_MS = 30 * 60_000;

const RETRIES = 3;

/** `baua logs` without --since: the newest lines, as many as the API gives by default. */
export const LOG_LINES = 100;

/** The API's largest page of log lines: `baua logs --since` and each poll of --follow. */
export const MAX_LOG_LINES = 1000;

/** `baua errors` without --since. */
export const ERRORS_SINCE_MS = 24 * 3_600_000;

const MAX_ERROR_GROUPS = 100;

/** baua keeps logs and traces for days, not years; the API takes no time before 1970. */
const MAX_SINCE_MS = 365 * 86_400_000;

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

const USAGE = `Usage:
  baua deploy <dir> --runtime <runtime> [--start <command>] [--preview <name>] [--project <org>/<name>]
  baua logs --project <org>/<name> [--preview <name>] [--since <time>] [--follow]
  baua errors --project <org>/<name> [--preview <name>] [--since <time>] [--stack]
  baua env pull [<file>] --project <org>/<name> [--preview <name>] [--force]
  baua run --project <org>/<name> [--preview <name>] -- <command> [<args>…]

  deploy   uploads the built app in <dir> to baua and follows the deployment until it runs
  logs     prints the app's log lines
  errors   lists the exceptions the app reported through OpenTelemetry, grouped by type and message
  env pull writes the app's environment variables to <file> (default .env); --force overwrites it
  run      starts <command> on this machine with the app's environment variables, without writing them to disk

Options:
  --runtime <runtime>   deploy: ${RUNTIMES.join(', ')}
  --start <command>     deploy: the start command; required for dotnet@* and binary (e.g. ./App or ./server)
  --preview <name>      the preview with this name instead of production
  --project <org>/<name>  the project; deploy: optional with a deploy token (bdt_…)
  --since <time>        logs, errors: how far back, e.g. 15m, 1h, 24h, 7d (logs: default the newest ${LOG_LINES} lines; errors: default 24h)
  -f, --follow          logs: keep printing new lines until Ctrl+C
  --stack               errors: print the newest stack trace of each group
  --force               env pull: overwrite an existing file
  -h, --help            show this help
  -v, --version         show the version

Environment:
  BAUA_TOKEN            required: a deploy token (bdt_…, deploy only) or an API token (baua_…)
  BAUA_URL              the console, default ${DEFAULT_URL}`;

export interface DeployOptions {
  dir: string;
  runtime: string;
  start?: string;
  preview?: string;
  project?: { org: string; name: string };
}

/** The options of `baua logs` and `baua errors`. */
export interface ReadOptions {
  project: { org: string; name: string };
  preview?: string;
  sinceMs?: number;
  follow: boolean;
  stack: boolean;
}

/** The options of `baua env pull` (`file`, `force`) and `baua run` (`command`). */
export interface EnvOptions {
  project: { org: string; name: string };
  preview?: string;
}

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'deploy'; options: DeployOptions }
  | { kind: 'logs' | 'errors'; options: ReadOptions }
  | { kind: 'env'; options: EnvOptions & { file: string; force: boolean } }
  | { kind: 'run'; options: EnvOptions & { command: string[] } }
  | { kind: 'error'; message: string };

export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  pack: (dir: string) => Promise<Packed>;
  /** Runs the command with these variables on top of the CLI's own environment; resolves to its exit code. */
  exec: (command: string[], vars: Record<string, string>) => Promise<number>;
  print: (line: string) => void;
  error: (line: string) => void;
}

export interface Packed {
  body: Uint8Array<ArrayBuffer>;
  files: number;
}

/** An expected failure: its message is printed, the exit code is 1. */
class CliError extends Error {}

/** The console could not be reached or answered 502/503/504 after the retries: while following a deployment, polling goes on. */
class UnreachableError extends CliError {}

const UNAVAILABLE = [502, 503, 504];

/** The options only some commands take. */
const ONLY: Record<string, string[]> = { runtime: ['deploy'], start: ['deploy'], since: ['logs', 'errors'], follow: ['logs'], stack: ['errors'], force: ['env'] };

/** Parses and checks the arguments locally, before anything is packed or sent. */
export function parseCommand(args: string[]): Command {
  let parsed;

  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        runtime: { type: 'string' },
        start: { type: 'string' },
        preview: { type: 'string' },
        project: { type: 'string' },
        since: { type: 'string' },
        follow: { type: 'boolean', short: 'f' },
        stack: { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    return { kind: 'error', message: (error as Error).message };
  }

  const { values, positionals } = parsed;
  // `baua run` takes its command after `--` only: without it, the command's own options (-f, --version) would be read as the CLI's.
  const dash = args.indexOf('--');
  const runCommand = dash < 0 ? [] : args.slice(dash + 1);
  if (positionals[0] === 'run' && !values.help && (runCommand.length === 0 || positionals.length !== runCommand.length + 1)) {
    return { kind: 'error', message: 'expected: baua run --project <org>/<name> -- <command> [<args>…]' };
  }

  if (values.help) {
    return { kind: 'help' };
  }

  if (values.version) {
    return { kind: 'version' };
  }

  const command = positionals[0];
  const read = (command === 'logs' || command === 'errors') && positionals.length === 1;
  const pull = command === 'env' && positionals[1] === 'pull' && positionals.length <= 3;
  const runs = command === 'run';
  if (!read && !pull && !runs && !(command === 'deploy' && positionals.length === 2)) {
    return { kind: 'error', message: 'expected: baua deploy <dir> --runtime <runtime>, baua logs, baua errors, baua env pull or baua run -- <command> (see --help)' };
  }

  const wrong = Object.keys(ONLY).find((name) => values[name as keyof typeof values] !== undefined && !ONLY[name].includes(command));
  if (wrong) {
    return { kind: 'error', message: `--${wrong} is not an option of baua ${command}` };
  }

  if (values.preview !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(values.preview)) {
    return { kind: 'error', message: '--preview must be a branch-like name: letters, digits, ".", "_", "/" and "-"' };
  }

  let project: { org: string; name: string } | undefined;
  if (values.project !== undefined) {
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(values.project);
    if (!match) {
      return { kind: 'error', message: '--project must be <org>/<name>' };
    }

    project = { org: match[1], name: match[2] };
  }

  if (command !== 'deploy' && !project) {
    return { kind: 'error', message: `--project <org>/<name> is required for baua ${command}` };
  }

  if (command === 'env' && project) {
    return { kind: 'env', options: { project, preview: values.preview, file: positionals[2] ?? '.env', force: values.force === true } };
  }

  if (command === 'run' && project) {
    return { kind: 'run', options: { project, preview: values.preview, command: runCommand } };
  }

  if ((command === 'logs' || command === 'errors') && project) {
    let sinceMs: number | undefined;
    if (values.since !== undefined) {
      const match = /^([1-9][0-9]{0,4})([mhd])$/.exec(values.since);
      if (!match) {
        return { kind: 'error', message: '--since must be a time like 15m, 1h, 24h or 7d' };
      }

      sinceMs = Number(match[1]) * UNIT_MS[match[2]];
      if (sinceMs > MAX_SINCE_MS) {
        return { kind: 'error', message: '--since must be at most 365d' };
      }
    }

    return { kind: command, options: { project, preview: values.preview, sinceMs, follow: values.follow === true, stack: values.stack === true } };
  }

  const runtime = values.runtime;
  if (!runtime || !RUNTIMES.includes(runtime)) {
    return { kind: 'error', message: `--runtime must be one of: ${RUNTIMES.join(', ')}` };
  }

  const start = values.start?.trim() || undefined;
  if (!start && (runtime.startsWith('dotnet@') || runtime === 'binary')) {
    return { kind: 'error', message: `--start is required for ${runtime} (e.g. ${runtime === 'binary' ? './server' : './App'})` };
  }

  return { kind: 'deploy', options: { dir: positionals[1], runtime, start, preview: values.preview, project } };
}

/** BAUA_URL without trailing slashes, or the default; https only, except for a local baua, so the token never travels in clear text. */
export function consoleUrl(value: string | undefined): string {
  const base = (value?.trim() || DEFAULT_URL).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new CliError(`BAUA_URL is not a URL: ${base}`);
  }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new CliError('BAUA_URL must start with https:// (http:// only for localhost)');
  }

  return base;
}

export function uploadUrl(base: string, project: { org: string; name: string }, options: DeployOptions): string {
  const query = new URLSearchParams({ runtime: options.runtime });
  if (options.start) {
    query.set('start', options.start);
  }

  if (options.preview) {
    query.set('preview', options.preview);
  }

  return `${base}/api/orgs/${encodeURIComponent(project.org)}/projects/${encodeURIComponent(project.name)}/deploy?${query}`;
}

/** The deployment's page in the console, when the server names no app URL. */
export function deploymentPage(base: string, project: { org: string; name: string }, id: string): string {
  return `${base}/${encodeURIComponent(project.org)}/${encodeURIComponent(project.name)}/deployments/${encodeURIComponent(id)}`;
}

/** The lines of a full log text that were not printed yet; the logs endpoint always answers the whole log. */
export function newLines(text: string, printed: number): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines.slice(printed);
}

/** The server's message of a failed answer: `error` or `message` of a JSON body, else the text. */
async function serverMessage(res: Response): Promise<string> {
  const text = (await res.text()).trim();

  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = body.error ?? body.message;
    if (typeof message === 'string') {
      return `${res.status}: ${message}`;
    }
  } catch {
    // not JSON: the text itself is the message
  }

  return `${res.status}: ${text || res.statusText}`;
}

/** A GET retried on network errors and 502/503/504, so a short hiccup does not fail a CI run. */
async function get(deps: Deps, url: string, token: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await deps.fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
      if (!UNAVAILABLE.includes(res.status) || attempt >= RETRIES) {
        return res;
      }

      await res.body?.cancel();
    } catch (error) {
      if (attempt >= RETRIES) {
        throw new UnreachableError(`cannot reach ${new URL(url).origin}: ${(error as Error).message}`);
      }
    }

    await deps.sleep(POLL_MS);
  }
}

async function getJson<T>(deps: Deps, url: string, token: string): Promise<T> {
  const res = await get(deps, url, token);
  if (!res.ok) {
    const message = await serverMessage(res);
    throw UNAVAILABLE.includes(res.status) ? new UnreachableError(message) : new CliError(message);
  }

  return (await res.json()) as T;
}

/** The project from --project, or the deploy token's own project. */
async function resolveProject(deps: Deps, base: string, token: string, options: DeployOptions): Promise<{ org: string; name: string }> {
  if (options.project) {
    return options.project;
  }

  if (!token.startsWith('bdt_')) {
    throw new CliError('--project <org>/<name> is required with an API token (only a deploy token knows its project)');
  }

  const { org, project } = await getJson<{ org: string; project: string }>(deps, `${base}/api/deploy-token`, token);

  return { org, name: project };
}

interface Deployment {
  id: string;
  status: string;
  error?: string | null;
  url?: string;
}

/** Polls the deployment and prints its new log lines until it runs (0) or fails (1). */
export async function follow(deps: Deps, base: string, token: string, id: string): Promise<{ status: string; error: string | null }> {
  let printed = 0;

  for (let waited = 0; waited <= TIMEOUT_MS; waited += POLL_MS) {
    // The status first: once it is final, the log fetched after it is complete. An update of baua restarts the console for longer
    // than the retries of one request; the deployment goes on meanwhile, so polling goes on until the timeout.
    let deployment: Deployment;
    let logs: Response;
    try {
      deployment = await getJson<Deployment>(deps, `${base}/api/deployments/${encodeURIComponent(id)}`, token);
      logs = await get(deps, `${base}/api/deployments/${encodeURIComponent(id)}/logs`, token);
    } catch (error) {
      if (!(error instanceof UnreachableError)) {
        throw error;
      }

      deps.print(`==> ${error.message}; still waiting`);
      // The retries slept too; counted, so an outage does not stretch the timeout.
      waited += (RETRIES - 1) * POLL_MS;
      await deps.sleep(POLL_MS);
      continue;
    }

    if (logs.ok) {
      const lines = newLines(await logs.text(), printed);
      for (const line of lines) {
        deps.print(line);
      }

      printed += lines.length;
    } else {
      await logs.body?.cancel();
    }

    if (['running', 'sleeping', 'failed', 'stopped', 'skipped'].includes(deployment.status)) {
      return { status: deployment.status, error: deployment.error ?? null };
    }

    await deps.sleep(POLL_MS);
  }

  return { status: 'timeout', error: `no result after ${TIMEOUT_MS / 60_000} minutes; the deployment goes on in baua` };
}

/** `baua …`: returns the exit code. */
export async function run(args: string[], env: Record<string, string | undefined>, deps: Deps): Promise<number> {
  const command = parseCommand(args);
  if (command.kind === 'help') {
    deps.print(USAGE);

    return 0;
  }

  if (command.kind === 'version') {
    deps.print(VERSION);

    return 0;
  }

  if (command.kind === 'error') {
    deps.error(`error: ${command.message}`);

    return 1;
  }

  const token = env.BAUA_TOKEN?.trim();
  if (!token) {
    deps.error('error: BAUA_TOKEN is not set (a deploy token from the project settings, or an API token)');

    return 1;
  }

  try {
    const base = consoleUrl(env.BAUA_URL);
    if (command.kind === 'deploy') {
      return await deploy(deps, base, token, command.options);
    }

    if (token.startsWith('bdt_')) {
      throw new CliError(`baua ${command.kind} needs an API token (baua_…) and --project; a deploy token can only deploy`);
    }

    if (command.kind === 'env') {
      return await pullEnv(deps, base, token, command.options);
    }

    if (command.kind === 'run') {
      return await runWithEnv(deps, base, token, command.options);
    }

    return command.kind === 'logs' ? await printLogs(deps, base, token, command.options) : await printErrors(deps, base, token, command.options);
  } catch (error) {
    if (error instanceof CliError) {
      deps.error(`error: ${error.message}`);

      return 1;
    }

    throw error;
  }
}

async function deploy(deps: Deps, base: string, token: string, options: DeployOptions): Promise<number> {
  const project = await resolveProject(deps, base, token, options);
  const packed = await deps.pack(options.dir);
  deps.print(`==> uploading ${options.dir}: ${packed.files} ${packed.files === 1 ? 'file' : 'files'}, ${(packed.body.byteLength / 1024 / 1024).toFixed(1)} MB to ${project.org}/${project.name}${options.preview ? ` (preview ${options.preview})` : ''}`);

  // Never retried: a lost answer may still have started a deployment.
  let res: Response;
  try {
    res = await deps.fetch(uploadUrl(base, project, options), { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' }, body: packed.body, redirect: 'error' });
  } catch (error) {
    throw new CliError(`upload failed: ${(error as Error).message}`);
  }

  if (res.status !== 202) {
    throw new CliError(`upload refused: ${await serverMessage(res)}`);
  }

  const created = (await res.json()) as Deployment;
  deps.print(`==> deployment ${created.id}`);
  const result = await follow(deps, base, token, created.id);
  if (result.status === 'running' || result.status === 'sleeping') {
    deps.print(`==> ${result.status}: ${created.url ?? deploymentPage(base, project, created.id)}`);

    return 0;
  }

  deps.error(`error: deployment ${result.status}${result.error ? `: ${result.error}` : ''}`);
  deps.error(`see ${deploymentPage(base, project, created.id)}`);

  return 1;
}

/** App text without escape sequences and control characters (tabs stay): an app's output must not control the user's terminal. */
export function clean(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

function projectApi(base: string, project: { org: string; name: string }): string {
  return `${base}/api/orgs/${encodeURIComponent(project.org)}/projects/${encodeURIComponent(project.name)}`;
}

/** The branch the API filters by: the preview's name, or the project's production branch. */
async function branchOf(deps: Deps, base: string, token: string, options: ReadOptions): Promise<string> {
  if (options.preview) {
    return options.preview;
  }

  const { org, name } = options.project;
  const projects = await getJson<{ name: string; branch: string }[]>(deps, `${base}/api/orgs/${encodeURIComponent(org)}/projects`, token);
  const found = projects.find((p) => p.name === name);
  if (!found) {
    throw new CliError(`project ${org}/${name} not found`);
  }

  return found.branch;
}

interface LogLine {
  id: number;
  stream: string;
  ts: string;
  line: string;
  truncated: boolean;
}

export function logLine(line: LogLine): string {
  return `${line.ts} ${line.stream === 'stderr' ? '[stderr] ' : ''}${clean(line.line)}${line.truncated ? ' …' : ''}`;
}

/** `baua logs`: the newest lines (or those since --since), then with --follow every new line until Ctrl+C. */
async function printLogs(deps: Deps, base: string, token: string, options: ReadOptions): Promise<number> {
  const branch = await branchOf(deps, base, token, options);
  const url = `${projectApi(base, options.project)}/logs`;
  const since = options.sinceMs === undefined ? undefined : new Date(Date.now() - options.sinceMs).toISOString();
  const first = new URLSearchParams({ branch, limit: String(since ? MAX_LOG_LINES : LOG_LINES) });
  if (since) {
    first.set('since', since);
  }

  const answer = await getJson<{ lines: LogLine[]; cursor: number | null }>(deps, `${url}?${first}`, token);
  let lines = answer.lines;
  if (since && answer.cursor !== null) {
    deps.error(`==> more than ${MAX_LOG_LINES} lines since ${since}: showing the newest ${MAX_LOG_LINES}`);
  }

  let last = 0;
  for (;;) {
    for (const line of lines.filter((l) => l.id > last)) {
      deps.print(logLine(line));
      last = line.id;
    }

    if (!options.follow) {
      return 0;
    }

    await deps.sleep(POLL_MS);
    // ponytail: more than MAX_LOG_LINES new lines within one poll: the older of them are skipped (the API answers the newest).
    const next = new URLSearchParams({ branch, limit: String(MAX_LOG_LINES) });
    if (last > 0) {
      next.set('after', String(last));
    } else if (since) {
      next.set('since', since);
    }

    try {
      ({ lines } = await getJson<{ lines: LogLine[] }>(deps, `${url}?${next}`, token));
    } catch (error) {
      if (!(error instanceof UnreachableError)) {
        throw error;
      }

      deps.print(`==> ${error.message}; still waiting`);
      lines = [];
    }
  }
}

interface ErrorGroup {
  type: string;
  message: string;
  count: number;
  first: string;
  last: string;
  traceId: string;
  stacktrace: string | null;
}

/** `baua errors`: the groups of exceptions, newest first, each with a link to its newest trace. */
async function printErrors(deps: Deps, base: string, token: string, options: ReadOptions): Promise<number> {
  const branch = await branchOf(deps, base, token, options);
  const since = new Date(Date.now() - (options.sinceMs ?? ERRORS_SINCE_MS)).toISOString();
  const query = new URLSearchParams({ branch, since, limit: String(MAX_ERROR_GROUPS) });
  const { errors } = await getJson<{ errors: ErrorGroup[] }>(deps, `${projectApi(base, options.project)}/errors?${query}`, token);
  if (errors.length === 0) {
    deps.print(`no errors since ${since}`);

    return 0;
  }

  const { org, name } = options.project;
  for (const [i, group] of errors.entries()) {
    if (i > 0) {
      deps.print('');
    }

    const title = [clean(group.type), clean(group.message)].filter(Boolean).join(': ') || '(no type or message)';
    deps.print(`${group.count}×  ${title}`);
    deps.print(`    last ${group.last}, first ${group.first}`);
    deps.print(`    ${base}/${encodeURIComponent(org)}/${encodeURIComponent(name)}/traces/${encodeURIComponent(group.traceId)}`);
    if (options.stack && group.stacktrace) {
      for (const line of group.stacktrace.split('\n')) {
        deps.print(`    ${clean(line)}`);
      }
    }
  }

  return 0;
}

interface EnvVariable {
  name: string;
  scope: 'production' | 'preview' | 'both';
  value: string | null;
}

/**
 * The variables production or a preview gets, as baua passes them to its container: the scope's own values and those for both, a
 * scope's own value before one for both. baua's own variables (OTEL_*, DATABASE_URL, DENO_KV_*) are set at the start of the container
 * and point inside baua; they are not in the list.
 */
export function scopeValues(variables: EnvVariable[], preview: boolean): Record<string, string> {
  const scope = preview ? 'preview' : 'production';
  const env: Record<string, string> = {};
  // 'both' first, so a scope's own value replaces it.
  const ordered = [...variables.filter((v) => v.scope === 'both'), ...variables.filter((v) => v.scope === scope)];

  for (const variable of ordered) {
    if (variable.value === null) {
      throw new CliError(`variable ${variable.name} cannot be decrypted – set it again in the console`);
    }

    env[variable.name] = variable.value;
  }

  return env;
}

/**
 * A .env file: one `NAME='value'` line per variable. Single quotes are read literally (Node.js `--env-file`, dotenv), line breaks stay
 * inside them. Refused, rather than read back changed: a `'`, a carriage return (the parsers turn CRLF into LF) or a trailing backslash
 * (it would escape the closing quote).
 */
export function dotenv(env: Record<string, string>, header: string): string {
  const lines = [`# ${header}`];

  for (const [name, value] of Object.entries(env)) {
    if (value.includes("'") || value.includes('\r') || value.endsWith('\\')) {
      throw new CliError(`the value of ${name} cannot be written to a .env file unchanged (a ', a carriage return or a trailing backslash); use baua run instead`);
    }

    lines.push(`${name}='${value}'`);
  }

  return `${lines.join('\n')}\n`;
}

async function fetchEnv(deps: Deps, base: string, token: string, options: EnvOptions): Promise<Record<string, string>> {
  const { variables } = await getJson<{ variables: EnvVariable[] }>(deps, `${projectApi(base, options.project)}/env`, token);

  return scopeValues(variables, options.preview !== undefined);
}

/** Every preview has the same values, so the preview's name is not checked and not named. */
function target(options: EnvOptions): string {
  return `${options.project.org}/${options.project.name} (${options.preview ? 'previews' : 'production'})`;
}

/** `baua env pull`: the variables into a new file only its owner can read; with --force an existing one is replaced, not reused with its mode. */
async function pullEnv(deps: Deps, base: string, token: string, options: EnvOptions & { file: string; force: boolean }): Promise<number> {
  const env = await fetchEnv(deps, base, token, options);
  const text = dotenv(env, `baua env pull: ${target(options)}, ${new Date().toISOString()}. Secrets – keep this file out of Git.`);

  try {
    if (options.force) {
      await rm(options.file, { force: true });
    }

    await writeFile(options.file, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CliError(code === 'EEXIST' ? `${options.file} exists; --force overwrites it` : `cannot write ${options.file}: ${(error as Error).message}`);
  }

  const count = Object.keys(env).length;
  deps.print(`==> ${count} ${count === 1 ? 'variable' : 'variables'} of ${target(options)} written to ${options.file}; keep it out of Git`);

  return 0;
}

/** `baua run`: the command's exit code; the CLI's messages go to stderr, so the command's stdout stays its own. */
async function runWithEnv(deps: Deps, base: string, token: string, options: EnvOptions & { command: string[] }): Promise<number> {
  const env = await fetchEnv(deps, base, token, options);
  const count = Object.keys(env).length;
  deps.error(`==> ${options.command[0]} with ${count} ${count === 1 ? 'variable' : 'variables'} of ${target(options)}`);

  return await deps.exec(options.command, env);
}

/** Runs the command without a shell, its output on this terminal; the variables replace those of the same name in the CLI's environment. */
export function exec(command: string[], vars: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      // ponytail: no shell, so npm, npx and other .cmd scripts on Windows need `cmd /c` in front; a shell would re-read the arguments.
      child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, ...vars } });
    } catch (error) {
      reject(new CliError(`cannot run ${command[0]}: ${(error as Error).message}`));

      return;
    }

    // Ctrl+C reaches the command from the terminal itself: the CLI waits for its exit code instead of ending first. A SIGTERM or SIGHUP
    // reaches only the CLI: it is passed on, so the command does not run on alone.
    const ignore = () => {};
    const pass = (signal: NodeJS.Signals) => child.kill(signal);
    const handlers = [['SIGINT', ignore], ['SIGTERM', pass], ['SIGHUP', pass]] as const;
    for (const [signal, handler] of handlers) {
      process.on(signal, handler);
    }

    const done = () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };

    child.on('error', (error) => {
      done();
      reject(new CliError(`cannot run ${command[0]}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      done();
      // Ended by a signal: 128 + its number, as a shell reports it (130 for Ctrl+C).
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

/** Packs the directory's contents with the system tar (flags GNU tar and bsdtar share); refuses symlinks, which baua refuses too. */
export async function pack(dir: string): Promise<Packed> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new CliError(`${dir} is not a directory`);
  }

  let files = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new CliError(`${relative(dir, join(entry.parentPath, entry.name))} is a symlink; baua accepts only files and directories`);
    }

    if (entry.isFile()) {
      files++;
    }
  }

  // The top-level names, not ".": entries without a leading "./". A name starting with "-" would read as a flag.
  const names = await readdir(dir);
  if (names.length === 0) {
    throw new CliError(`${dir} is empty`);
  }

  const flagLike = names.find((name) => name.startsWith('-'));
  if (flagLike) {
    throw new CliError(`${flagLike}: names starting with "-" are not supported at the top of the directory`);
  }

  const body = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    // COPYFILE_DISABLE: macOS tar adds no ._ files.
    const child = spawn('tar', ['-czf', '-', '-C', dir, ...names], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => reject(new CliError(`cannot run tar: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new CliError(`tar failed (${code}): ${Buffer.concat(err).toString().trim()}`));

        return;
      }

      resolve(Buffer.concat(out));
    });
  });

  return { body, files };
}

// `import.meta.main` exists from Node.js 24.2 (and in Deno); older Node.js versions compare the started file.
if (import.meta.main ?? (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))) {
  const deps: Deps = {
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pack,
    exec,
    print: (line) => console.log(line),
    error: (line) => console.error(line),
  };

  // Not process.exit: output to a pipe may still be pending.
  process.exitCode = await run(process.argv.slice(2), process.env, deps);
}
