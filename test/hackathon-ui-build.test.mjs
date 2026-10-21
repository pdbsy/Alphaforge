import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('product build preserves the original UI and excludes retired setup pages and internal documents', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'alphaforge-web-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  execFileSync(process.execPath, ['tools/import-user-ui.mjs'], { stdio: 'pipe' });
  execFileSync(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'build',
      'apps/web',
      '--config',
      'apps/web/vite.config.ts',
      '--outDir',
      out,
    ],
    { stdio: 'pipe' },
  );
  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('/user-ui.css'));
  assert.ok(html.includes('/user-ui.js'));
  assert.ok(html.includes('AlphaForge'));
  assert.deepEqual((await readdir(out)).sort(), ['assets', 'index.html', 'user-ui.css', 'user-ui.js']);
  const chunks = await readdir(join(out, 'assets'));
  assert.ok(chunks.every((name) => name.startsWith('product-')));
  for (const name of chunks.filter((name) => name.endsWith('.js'))) {
    assert.doesNotMatch(
      await readFile(join(out, 'assets', name), 'utf8'),
      /data-stock-data-form|data-launch-executor-order|Configure an executor/,
    );
  }
  const source = await readFile('apps/web/prototype/AlphaForge_v3_EN.html', 'utf8');
  assert.equal(
    await readFile(join(out, 'user-ui.css'), 'utf8'),
    source.match(/<style>([\s\S]*?)<\/style>/)[1],
  );
  assert.ok((await readFile(join(out, 'user-ui.js'), 'utf8')).includes('data-user-style'));
});

test('actual development middleware serves imported CSS and JavaScript and passes other requests to Vite', async (t) => {
  const { createServer } = await import('vite');
  const { default: config } = await import('../apps/web/vite.config.ts');
  const { resolve } = await import('node:path');
  execFileSync(process.execPath, ['tools/import-user-ui.mjs'], { stdio: 'pipe' });
  const server = await createServer({
    ...config,
    configFile: false,
    root: resolve('apps/web'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  t.after(() => server.close());
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [name, type] of [
    ['user-ui.css', 'text/css; charset=utf-8'],
    ['user-ui.js', 'text/javascript; charset=utf-8'],
  ]) {
    const response = await fetch(`${origin}/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(await response.text(), await readFile(`build/ui-import/${name}`, 'utf8'));
  }
  const response = await fetch(origin + '/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\/src\/product-ui\.ts/);
});
