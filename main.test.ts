import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertEquals, assertMatch, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { clean, consoleUrl, type Deps, deploymentPage, dotenv, ERRORS_SINCE_MS, exec, logLine, MAX_LOG_LINES, newLines, pack, parseCommand, run, scopeValues, TIMEOUT_MS, POLL_MS, uploadUrl, VERSION } from './main.ts';

const BASE = 'https://console.example';

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Answers by `METHOD path` (without the query); several answers for one key are used in turn, the last one repeats. */
function fakeDeps(routes: Record<string, Route | Route[]>, maxSleeps = Infinity) {
  const printed: string[] = [];
  const errors: string[] = [];
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  const executed: { command: string[]; vars: Record<string, string> }[] = [];
  const calls = new Map<string, number>();
  let slept = 0;
  const deps: Deps = {
    fetch: (async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const url = new URL(input);
      const key = `${method} ${url.pathname}`;
      requests.push({ method, url: input, headers: init.headers as Record<string, string> });
      const route = routes[key];
      if (!route) {
        return new Response('not found', { status: 404 });
      }

      const list = Array.isArray(route) ? route : [route];
      const n = calls.get(key) ?? 0;
      calls.set(key, n + 1);

      return await list[Math.min(n, list.length - 1)](input, init);
    }) as typeof fetch,
    // With maxSleeps, a command that never ends (logs --follow) stops by this error.
    sleep: async (ms) => {
      slept += ms;
      if (slept / POLL_MS > maxSleeps) {
        throw new Error('stop');
      }
    },
    pack: async () => ({ body: new Uint8Array([1, 2, 3]), files: 3 }),
    exec: async (command, vars) => {
      executed.push({ command, vars });

      return 7;
    },
    print: (line) => printed.push(line),
    error: (line) => errors.push(line),
  };

  return { deps, printed, errors, requests, executed, slept: () => slept };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const text = (body: string) => () => new Response(body);

test('parseCommand: a deploy with all options', () => {
  assertEquals(parseCommand(['deploy', 'out', '--runtime', 'dotnet@10', '--start', './App', '--preview', 'feature/x', '--project', 'acme/shop']), {
    kind: 'deploy',
    options: { dir: 'out', runtime: 'dotnet@10', start: './App', preview: 'feature/x', project: { org: 'acme', name: 'shop' } },
  });
});

test('parseCommand: help, version and refused arguments', () => {
  assertEquals(parseCommand(['--help']).kind, 'help');
  assertEquals(parseCommand(['-v']).kind, 'version');

  const refused: [string[], string][] = [
    [[], 'expected'],
    [['deploy'], 'expected'],
    [['push', 'out', '--runtime', 'static'], 'expected'],
    [['deploy', 'out'], '--runtime'],
    [['deploy', 'out', '--runtime', 'python@3'], '--runtime'],
    [['deploy', 'out', '--runtime', 'dotnet@8'], '--start is required for dotnet@8'],
    [['deploy', 'out', '--runtime', 'binary', '--start', ' '], '--start is required for binary'],
    [['deploy', 'out', '--runtime', 'static', '--preview', '-x'], '--preview'],
    [['deploy', 'out', '--runtime', 'static', '--preview', 'a b'], '--preview'],
    [['deploy', 'out', '--runtime', 'static', '--project', 'shop'], '--project'],
    [['deploy', 'out', '--runtime', 'static', '--project', 'a/b/c'], '--project'],
    [['deploy', 'out', '--runtime', 'static', '--unknown'], 'Unknown option'],
    [['deploy', 'out', '--runtime', 'static', '--follow'], '--follow is not an option of baua deploy'],
    [['logs'], '--project <org>/<name> is required for baua logs'],
    [['errors', '--project', 'shop'], '--project'],
    [['logs', 'extra', '--project', 'acme/shop'], 'expected'],
    [['logs', '--project', 'acme/shop', '--runtime', 'node@24'], '--runtime is not an option of baua logs'],
    [['logs', '--project', 'acme/shop', '--stack'], '--stack is not an option of baua logs'],
    [['errors', '--project', 'acme/shop', '-f'], '--follow is not an option of baua errors'],
    [['logs', '--project', 'acme/shop', '--since', '1w'], '--since'],
    [['logs', '--project', 'acme/shop', '--since', '0h'], '--since'],
    [['errors', '--project', 'acme/shop', '--since', '2026-10-01'], '--since'],
    [['errors', '--project', 'acme/shop', '--since', '99999d'], '--since must be at most 365d'],
  ];
  for (const [args, message] of refused) {
    const command = parseCommand(args);
    assertEquals(command.kind, 'error', args.join(' '));
    assertStringIncludes((command as { message: string }).message, message);
  }

  // Runtimes with a default start command need none.
  assertEquals(parseCommand(['deploy', 'dist', '--runtime', 'node@24']).kind, 'deploy');
});

test('consoleUrl: default and trailing slashes', () => {
  assertEquals(consoleUrl(undefined), 'https://console.baua.ch');
  assertEquals(consoleUrl(' '), 'https://console.baua.ch');
  assertEquals(consoleUrl('http://127.0.0.1:4000//'), 'http://127.0.0.1:4000');
  assertEquals(consoleUrl('http://localhost:8000'), 'http://localhost:8000');
});

test('consoleUrl: https only, except for a local baua', () => {
  assertThrows(() => consoleUrl('http://console.baua.ch'), Error, 'https://');
  assertThrows(() => consoleUrl('ftp://localhost'), Error, 'https://');
  assertThrows(() => consoleUrl('console.baua.ch'), Error, 'not a URL');
});

test('uploadUrl and deploymentPage encode their parts', () => {
  const project = { org: 'acme', name: 'shop' };
  assertEquals(uploadUrl(BASE, project, { dir: 'out', runtime: 'node@24' }), `${BASE}/api/orgs/acme/projects/shop/deploy?runtime=node%4024`);
  assertEquals(uploadUrl(BASE, project, { dir: 'out', runtime: 'dotnet@10', start: 'dotnet App.dll', preview: 'feature/x' }), `${BASE}/api/orgs/acme/projects/shop/deploy?runtime=dotnet%4010&start=dotnet+App.dll&preview=feature%2Fx`);
  assertEquals(deploymentPage(BASE, project, 'd1'), `${BASE}/acme/shop/deployments/d1`);
});

test('newLines: only the lines not printed yet', () => {
  assertEquals(newLines('', 0), []);
  assertEquals(newLines('a\nb\n', 0), ['a', 'b']);
  assertEquals(newLines('a\nb\nc\n', 2), ['c']);
  assertEquals(newLines('a\nb\n', 2), []);
});

test('VERSION equals jsr.json', async () => {
  const jsr = JSON.parse(await readFile(new URL('./jsr.json', import.meta.url), 'utf-8')) as { version: string };
  assertEquals(VERSION, jsr.version);
});

test('run: a deploy token finds its project, uploads, prints each log line once and the URL', async () => {
  const fake = fakeDeps({
    'GET /api/deploy-token': json({ org: 'acme', project: 'shop' }),
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued', url: 'https://shop.acme.baua.app' }, 202),
    'GET /api/deployments/d1': [json({ id: 'd1', status: 'queued', error: null }), json({ id: 'd1', status: 'building', error: null }), json({ id: 'd1', status: 'running', error: null })],
    'GET /api/deployments/d1/logs': [text(''), text('==> upload\n'), text('==> upload\n==> started\n')],
  });

  const code = await run(['deploy', 'out', '--runtime', 'node@24'], { BAUA_TOKEN: 'bdt_secret', BAUA_URL: `${BASE}/` }, fake.deps);

  assertEquals([code, fake.errors], [0, []]);
  assertEquals(fake.printed.slice(1), ['==> deployment d1', '==> upload', '==> started', '==> running: https://shop.acme.baua.app']);
  assertMatch(fake.printed[0], /^==> uploading out: 3 files, 0\.0 MB to acme\/shop$/);

  const upload = fake.requests.find((r) => r.method === 'PUT')!;
  assertEquals(upload.headers['content-type'], 'application/gzip');
  assertEquals(upload.headers.authorization, 'Bearer bdt_secret');
  assertEquals(fake.slept(), 2 * POLL_MS);
  // The token never reaches the output.
  assertEquals(
    [...fake.printed, ...fake.errors].some((line) => line.includes('bdt_secret')),
    false,
  );
});

test('run: without a url in the answer, the console link is printed', async () => {
  const fake = fakeDeps({
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202),
    'GET /api/deployments/d1': json({ id: 'd1', status: 'sleeping', error: null }),
    'GET /api/deployments/d1/logs': text(''),
  });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertEquals(fake.printed.at(-1), `==> sleeping: ${BASE}/acme/shop/deployments/d1`);
});

test('run: a failed deployment prints its error and exits 1', async () => {
  const fake = fakeDeps({
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202),
    'GET /api/deployments/d1': json({ id: 'd1', status: 'failed', error: 'health check failed' }),
    'GET /api/deployments/d1/logs': text('==> starting\n'),
  });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 1);
  assertEquals(fake.printed.at(-1), '==> starting');
  assertEquals(fake.errors, ['error: deployment failed: health check failed', `see ${BASE}/acme/shop/deployments/d1`]);
});

test('run: the server refuses the upload', async () => {
  const fake = fakeDeps({ 'PUT /api/orgs/acme/projects/shop/deploy': json({ error: 'a Git project takes no uploads' }, 409) });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 1);
  assertEquals(fake.errors, ['error: upload refused: 409: a Git project takes no uploads']);
});

test('run: missing token, API token without --project, unknown deploy token', async () => {
  const fake = fakeDeps({ 'GET /api/deploy-token': () => new Response('invalid token', { status: 401 }) });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static'], {}, fake.deps), 1);
  assertStringIncludes(fake.errors.at(-1)!, 'BAUA_TOKEN is not set');

  assertEquals(await run(['deploy', 'out', '--runtime', 'static'], { BAUA_TOKEN: 'baua_x' }, fake.deps), 1);
  assertStringIncludes(fake.errors.at(-1)!, '--project <org>/<name> is required');

  assertEquals(await run(['deploy', 'out', '--runtime', 'static'], { BAUA_TOKEN: 'bdt_x', BAUA_URL: BASE }, fake.deps), 1);
  assertEquals(fake.errors.at(-1), 'error: 401: invalid token');
  assertEquals(
    fake.requests.filter((r) => r.method === 'PUT'),
    [],
  );
});

test('run: network errors and 503 while polling are retried', async () => {
  let failures = 0;
  const fake = fakeDeps({
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202),
    'GET /api/deployments/d1': [
      () => {
        failures++;
        throw new TypeError('fetch failed');
      },
      () => new Response('busy', { status: 503 }),
      json({ id: 'd1', status: 'running', error: null }),
    ],
    'GET /api/deployments/d1/logs': text(''),
  });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertEquals(failures, 1);
});

test('run: a longer outage while polling (an update of baua) waits for the deployment', async () => {
  const down = () => {
    throw new TypeError('fetch failed');
  };
  const fake = fakeDeps({
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202),
    'GET /api/deployments/d1': [...Array.from({ length: 10 }, () => down), () => new Response('bad gateway', { status: 502 }), json({ id: 'd1', status: 'running', error: null })],
    'GET /api/deployments/d1/logs': text(''),
  });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertStringIncludes(fake.printed.join('\n'), `==> cannot reach ${BASE}: fetch failed; still waiting`);
});

test('run: a console that stays down times out like a deployment that never finishes', async () => {
  const fake = fakeDeps({
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202),
    'GET /api/deployments/d1': () => {
      throw new TypeError('fetch failed');
    },
  });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 1);
  assertStringIncludes(fake.errors[0], 'deployment timeout: no result after 30 minutes');
  assertEquals(fake.slept() <= TIMEOUT_MS + 3 * POLL_MS, true);
});

test('run: a 404 while polling fails at once', async () => {
  const fake = fakeDeps({ 'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202) });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 1);
  assertEquals(fake.errors, ['error: 404: not found']);
});

test('run: a deployment that never finishes times out', async () => {
  const fake = fakeDeps({
    'PUT /api/orgs/acme/projects/shop/deploy': json({ id: 'd1', status: 'queued' }, 202),
    'GET /api/deployments/d1': json({ id: 'd1', status: 'building', error: null }),
    'GET /api/deployments/d1/logs': text(''),
  });

  assertEquals(await run(['deploy', 'out', '--runtime', 'static', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 1);
  assertStringIncludes(fake.errors[0], 'deployment timeout: no result after 30 minutes');
  assertEquals(fake.slept() >= TIMEOUT_MS, true);
});

test('pack: a gzip tar of the contents without "./", refusing symlinks and empty directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baua-cli-'));
  try {
    await assertRejects(() => pack(dir), Error, 'is empty');

    await writeFile(join(dir, 'index.js'), 'console.log(1);\n');
    await mkdir(join(dir, 'lib'));
    await writeFile(join(dir, 'lib', 'a.js'), 'export {};\n');
    const packed = await pack(dir);
    assertEquals(packed.files, 2);
    const tar = gunzipSync(packed.body).toString('latin1');
    assertStringIncludes(tar, 'index.js');
    assertStringIncludes(tar, 'lib/a.js');
    assertEquals(tar.includes('./'), false);

    const linked = await symlink(join(dir, 'index.js'), join(dir, 'link.js')).then(
      () => true,
      () => false, // Windows without the right to create symlinks
    );
    if (linked) {
      await assertRejects(() => pack(dir), Error, 'link.js is a symlink');
    }

    await assertRejects(() => pack(join(dir, 'missing')), Error, 'is not a directory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseCommand: logs and errors', () => {
  assertEquals(parseCommand(['logs', '--project', 'acme/shop', '--since', '15m', '-f']), {
    kind: 'logs',
    options: { project: { org: 'acme', name: 'shop' }, preview: undefined, sinceMs: 15 * 60_000, follow: true, stack: false },
  });
  assertEquals(parseCommand(['errors', '--project', 'acme/shop', '--preview', 'feature/x', '--since', '7d', '--stack']), {
    kind: 'errors',
    options: { project: { org: 'acme', name: 'shop' }, preview: 'feature/x', sinceMs: 7 * 86_400_000, follow: false, stack: true },
  });
});

test('clean and logLine: app text cannot control the terminal', () => {
  assertEquals(clean('\u001b[31mred\u001b[0m\ttab\r\u0007\u009b'), 'red\ttab');
  assertEquals(logLine({ id: 1, stream: 'stderr', ts: '2026-10-25T12:00:00Z', line: '\u001b]0;title\u0007boom', truncated: true }), '2026-10-25T12:00:00Z [stderr] ]0;titleboom …');
  assertEquals(logLine({ id: 1, stream: 'stdout', ts: '2026-10-25T12:00:00Z', line: 'ok', truncated: false }), '2026-10-25T12:00:00Z ok');
});

const PROJECTS = json([
  { name: 'other', branch: 'dev' },
  { name: 'shop', branch: 'main' },
]);

const line = (id: number, text: string) => ({ id, deploymentId: 'd1', stream: 'stdout', ts: `2026-10-25T12:00:0${id}Z`, line: text, truncated: false });

test('run logs: production by its branch, the newest lines, the API token sent', async () => {
  const fake = fakeDeps({
    'GET /api/orgs/acme/projects': PROJECTS,
    'GET /api/orgs/acme/projects/shop/logs': json({ lines: [line(1, 'a'), line(2, 'b')], cursor: null }),
  });

  assertEquals(await run(['logs', '--project', 'acme/shop'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertEquals(fake.printed, ['2026-10-25T12:00:01Z a', '2026-10-25T12:00:02Z b']);
  assertEquals(Object.fromEntries(new URL(fake.requests[1].url).searchParams), { branch: 'main', limit: '100' });
  assertEquals(fake.requests[1].headers.authorization, 'Bearer baua_x');
});

test('run logs --since: up to 1000 lines from then; a preview needs no project lookup', async () => {
  const fake = fakeDeps({ 'GET /api/orgs/acme/projects/shop/logs': json({ lines: [], cursor: null }) });
  const before = Date.now();

  assertEquals(await run(['logs', '--project', 'acme/shop', '--preview', 'feature/x', '--since', '1h'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertEquals(fake.requests.length, 1);
  const query = new URL(fake.requests[0].url).searchParams;
  assertEquals([query.get('branch'), query.get('limit')], ['feature/x', String(MAX_LOG_LINES)]);
  const since = Date.parse(query.get('since')!);
  assertEquals(since >= before - 3_600_000 && since <= Date.now() - 3_600_000, true);
});

test('run logs --since: more lines than one page says that only the newest are shown', async () => {
  const fake = fakeDeps({ 'GET /api/orgs/acme/projects/shop/logs': json({ lines: [line(9, 'z')], cursor: 9 }) });

  assertEquals(await run(['logs', '--project', 'acme/shop', '--preview', 'feature/x', '--since', '7d'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertEquals(fake.printed, ['2026-10-25T12:00:09Z z']);
  assertEquals(fake.errors.length, 1);
  assertEquals(fake.errors[0].includes(`showing the newest ${MAX_LOG_LINES}`), true);
});

test('run logs --follow: polls with after, prints each line once, waits through an outage', async () => {
  const busy = () => new Response('busy', { status: 503 });
  const fake = fakeDeps(
    {
      'GET /api/orgs/acme/projects': PROJECTS,
      'GET /api/orgs/acme/projects/shop/logs': [json({ lines: [], cursor: null }), json({ lines: [line(3, 'c')], cursor: null }), busy, busy, busy, json({ lines: [line(3, 'c'), line(4, 'd')], cursor: null })],
    },
    10,
  );

  await assertRejects(() => run(['logs', '--project', 'acme/shop', '--follow'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), Error, 'stop');
  assertEquals(
    fake.printed.filter((l) => !l.startsWith('==>')),
    ['2026-10-25T12:00:03Z c', '2026-10-25T12:00:04Z d'],
  );
  assertStringIncludes(fake.printed.join('\n'), '==> 503: busy; still waiting');
  const polls = fake.requests.filter((r) => r.url.includes('/logs')).map((r) => new URL(r.url).searchParams.get('after'));
  assertEquals(polls.slice(0, 3), [null, null, '3']);
});

test('run logs and errors: a deploy token is refused before any request, an unknown project is named', async () => {
  const fake = fakeDeps({ 'GET /api/orgs/acme/projects': PROJECTS });

  assertEquals(await run(['logs', '--project', 'acme/shop'], { BAUA_TOKEN: 'bdt_x', BAUA_URL: BASE }, fake.deps), 1);
  assertStringIncludes(fake.errors.at(-1)!, 'baua logs needs an API token');
  assertEquals(fake.requests, []);

  assertEquals(await run(['errors', '--project', 'acme/gone'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 1);
  assertEquals(fake.errors.at(-1), 'error: project acme/gone not found');
});

test('run errors: groups with counts, times, trace links and with --stack the stack trace', async () => {
  const fake = fakeDeps({
    'GET /api/orgs/acme/projects': PROJECTS,
    'GET /api/orgs/acme/projects/shop/errors': json({
      errors: [
        { type: 'TypeError', message: 'x is undefined', count: 3, first: '2026-10-25T10:00:00Z', last: '2026-10-25T12:00:00Z', traceId: 'a'.repeat(32), deploymentId: 'd1', stacktrace: 'TypeError: x\n    at f (\u001b[31mapp.js:1)' },
        { type: '', message: '', count: 1, first: '2026-10-25T09:00:00Z', last: '2026-10-25T09:00:00Z', traceId: 'b'.repeat(32), deploymentId: 'd1', stacktrace: null },
      ],
    }),
  });
  const before = Date.now();

  assertEquals(await run(['errors', '--project', 'acme/shop', '--stack'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertEquals(fake.printed, [
    '3×  TypeError: x is undefined',
    '    last 2026-10-25T12:00:00Z, first 2026-10-25T10:00:00Z',
    `    ${BASE}/acme/shop/traces/${'a'.repeat(32)}`,
    '    TypeError: x',
    '        at f (app.js:1)',
    '',
    '1×  (no type or message)',
    '    last 2026-10-25T09:00:00Z, first 2026-10-25T09:00:00Z',
    `    ${BASE}/acme/shop/traces/${'b'.repeat(32)}`,
  ]);
  const query = new URL(fake.requests[1].url).searchParams;
  assertEquals([query.get('branch'), query.get('limit')], ['main', '100']);
  assertEquals(Date.parse(query.get('since')!) >= before - ERRORS_SINCE_MS, true);
});

test('run errors: nothing found', async () => {
  const fake = fakeDeps({ 'GET /api/orgs/acme/projects/shop/errors': json({ errors: [] }) });

  assertEquals(await run(['errors', '--project', 'acme/shop', '--preview', 'pr-1', '--since', '15m'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 0);
  assertMatch(fake.printed[0], /^no errors since \d{4}-\d{2}-\d{2}T/);
});

test('parseCommand: env pull and run', () => {
  const project = { org: 'acme', name: 'shop' };
  assertEquals(parseCommand(['env', 'pull', '--project', 'acme/shop']), { kind: 'env', options: { project, preview: undefined, file: '.env', force: false } });
  assertEquals(parseCommand(['env', 'pull', '.env.local', '--project', 'acme/shop', '--preview', 'pr-1', '--force']), { kind: 'env', options: { project, preview: 'pr-1', file: '.env.local', force: true } });
  assertEquals(parseCommand(['run', '--project', 'acme/shop', '--', 'node', '--watch', 'main.ts']), { kind: 'run', options: { project, preview: undefined, command: ['node', '--watch', 'main.ts'] } });

  assertEquals(parseCommand(['env', 'pull']), { kind: 'error', message: '--project <org>/<name> is required for baua env' });
  assertEquals(parseCommand(['run', '--project', 'acme/shop']).kind, 'error');
  // Without `--` the command's own options would be read as the CLI's.
  const noDash = { kind: 'error', message: 'expected: baua run --project <org>/<name> -- <command> [<args>…]' };
  assertEquals(parseCommand(['run', '--project', 'acme/shop', 'node', 'main.ts']), noDash);
  assertEquals(parseCommand(['run', '--project', 'acme/shop', 'node', '--version']), noDash);
  assertEquals(parseCommand(['run', 'foo', '--project', 'acme/shop', '--', 'node']), noDash);
  assertEquals(parseCommand(['env', 'push', '--project', 'acme/shop']).kind, 'error');
  assertEquals(parseCommand(['run', '--force', '--project', 'acme/shop', '--', 'node']), { kind: 'error', message: '--force is not an option of baua run' });
});

test('scopeValues: a scope gets its own values and those for both, its own first', () => {
  const variables = [
    { name: 'API_URL', scope: 'production' as const, value: 'https://api' },
    { name: 'API_URL', scope: 'preview' as const, value: 'https://staging' },
    { name: 'GREETING', scope: 'both' as const, value: 'hi' },
    { name: 'DEBUG', scope: 'preview' as const, value: '1' },
  ];

  assertEquals(scopeValues(variables, false), { GREETING: 'hi', API_URL: 'https://api' });
  assertEquals(scopeValues(variables, true), { GREETING: 'hi', API_URL: 'https://staging', DEBUG: '1' });
  assertEquals(scopeValues([{ name: 'X', scope: 'both', value: 'both' }, { name: 'X', scope: 'production', value: 'own' }], false), { X: 'own' });
  assertThrows(() => scopeValues([{ name: 'KEY', scope: 'both', value: null }], false), Error, 'variable KEY cannot be decrypted');
});

test('dotenv: single quotes, line breaks inside them; what would be read back changed is refused', () => {
  assertEquals(dotenv({ A: 'plain', B: 'say "hi" `now` $HOME', C: 'two\nlines # not a comment', D: 'C:\\new\\dir' }, 'head'), "# head\nA='plain'\nB='say \"hi\" `now` $HOME'\nC='two\nlines # not a comment'\nD='C:\\new\\dir'\n");
  for (const value of ["it's", 'crlf\r\nline', 'C:\\dir\\']) {
    assertThrows(() => dotenv({ K: value }, 'h'), Error, 'the value of K cannot be written to a .env file unchanged');
  }
});

test('run env pull: writes the production values to a file, an existing one only with --force', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baua-env-'));
  const file = join(dir, '.env');
  const fake = fakeDeps({
    'GET /api/orgs/acme/projects/shop/env': json({ variables: [{ name: 'KEY', scope: 'both', value: 's3cret', readable: true }, { name: 'ONLY_PREVIEW', scope: 'preview', value: 'x', readable: true }] }),
  });
  const env = { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE };

  try {
    assertEquals(await run(['env', 'pull', file, '--project', 'acme/shop'], env, fake.deps), 0);
    assertMatch(await readFile(file, 'utf8'), /^# baua env pull: acme\/shop \(production\), .*\nKEY='s3cret'\n$/);
    assertEquals(fake.requests[0].headers, { authorization: 'Bearer baua_x' });
    assertEquals(fake.printed, [`==> 1 variable of acme/shop (production) written to ${file}; keep it out of Git`]);

    assertEquals(await run(['env', 'pull', file, '--project', 'acme/shop', '--preview', 'pr-1'], env, fake.deps), 1);
    assertEquals(fake.errors, [`error: ${file} exists; --force overwrites it`]);

    // --force replaces the file: a new one only its owner can read, not the old one with its mode.
    await chmod(file, 0o644);
    assertEquals(await run(['env', 'pull', file, '--project', 'acme/shop', '--preview', 'pr-1', '--force'], env, fake.deps), 0);
    assertStringIncludes(await readFile(file, 'utf8'), "# baua env pull: acme/shop (previews)");
    assertStringIncludes(await readFile(file, 'utf8'), "ONLY_PREVIEW='x'");
    if (process.platform !== 'win32') {
      assertEquals((await stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('run run: the command gets the values and its exit code is the CLI\'s; a deploy token is refused', async () => {
  const fake = fakeDeps({ 'GET /api/orgs/acme/projects/shop/env': json({ variables: [{ name: 'KEY', scope: 'production', value: 's3cret', readable: true }] }) });

  assertEquals(await run(['run', '--project', 'acme/shop', '--', 'node', 'main.ts'], { BAUA_TOKEN: 'baua_x', BAUA_URL: BASE }, fake.deps), 7);
  assertEquals(fake.executed, [{ command: ['node', 'main.ts'], vars: { KEY: 's3cret' } }]);
  assertEquals(fake.printed, []);
  assertEquals(fake.errors, ['==> node with 1 variable of acme/shop (production)']);

  assertEquals(await run(['run', '--project', 'acme/shop', '--', 'node'], { BAUA_TOKEN: 'bdt_x', BAUA_URL: BASE }, fake.deps), 1);
  assertStringIncludes(fake.errors.at(-1)!, 'baua run needs an API token');
  assertEquals(fake.executed.length, 1);
});

test('exec: the variables reach the command, its exit code comes back', async () => {
  const code = await exec([process.execPath, '-e', 'process.exit(process.env.BAUA_TEST_VAR === "y" ? 3 : 4)'], { BAUA_TEST_VAR: 'y' });
  assertEquals(code, 3);
  assertEquals(await exec([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], {}), process.platform === 'win32' ? 1 : 143);
  await assertRejects(() => exec(['baua-no-such-command'], {}), Error, 'cannot run baua-no-such-command');
  await assertRejects(() => exec([''], {}), Error, 'cannot run');
});
