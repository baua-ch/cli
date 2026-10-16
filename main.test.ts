import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertEquals, assertMatch, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { consoleUrl, type Deps, deploymentPage, newLines, pack, parseCommand, run, TIMEOUT_MS, POLL_MS, uploadUrl, VERSION } from './main.ts';

const BASE = 'https://console.example';

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Answers by `METHOD path` (without the query); several answers for one key are used in turn, the last one repeats. */
function fakeDeps(routes: Record<string, Route | Route[]>) {
  const printed: string[] = [];
  const errors: string[] = [];
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
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
    sleep: async (ms) => {
      slept += ms;
    },
    pack: async () => ({ body: new Uint8Array([1, 2, 3]), files: 3 }),
    print: (line) => printed.push(line),
    error: (line) => errors.push(line),
  };

  return { deps, printed, errors, requests, slept: () => slept };
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
