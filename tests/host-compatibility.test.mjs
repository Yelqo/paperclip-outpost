import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { versions } from '../plugin/versions.ts';

test('host advertises the installed shared version for source and published ESM packages', async t => {
  const host = resolve('.cache/paperclip');
  const shared = JSON.parse(readFileSync(join(host, 'packages/shared/package.json'), 'utf8'));
  const source = readFileSync(join(host, 'server/src/realtime/plugin-ws.ts'), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' });
  const directory = mkdtempSync(join(tmpdir(), 'outpost-host-compatibility-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  for (const [name, exports, expected] of [
    ['source', shared.exports, shared.version],
    ['published', shared.publishConfig.exports, shared.version],
    ['missing metadata', undefined, ''],
  ]) await t.test(name, async t => {
    const fixture = join(directory, name);
    const realtime = join(fixture, 'server/dist/realtime');
    const services = join(fixture, 'server/dist/services');
    const sdk = join(fixture, 'node_modules/@paperclipai/plugin-sdk');
    mkdirSync(realtime, { recursive: true });
    mkdirSync(services, { recursive: true });
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(realtime, 'plugin-ws.js'), code);
    writeFileSync(join(services, 'plugin-registry.js'), `export const pluginRegistryService = () => ({
      getByKey: async () => ({ id: 'test.plugin', status: 'ready', manifestJson: {
        capabilities: ['transport.websockets.register'], webSocketRoutes: [{ routeKey: 'transport' }],
      } }),
    });`);
    writeFileSync(join(fixture, 'server/dist/build-commit.js'),
      `export const readBuildCommit = () => ${JSON.stringify(versions.host)};`);
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
    writeFileSync(join(sdk, 'index.js'), `export const PLUGIN_WEBSOCKET_SDK_VERSION = ${JSON.stringify(versions.sdk)};`);
    symlinkSync(realpathSync(resolve('node_modules/ws')), join(fixture, 'node_modules/ws'));
    if (exports) {
      const packageRoot = join(fixture, 'node_modules/@paperclipai/shared');
      for (const entry of ['src/index.ts', 'dist/index.js']) {
        mkdirSync(join(packageRoot, entry, '..'), { recursive: true });
        writeFileSync(join(packageRoot, entry), 'export {};');
      }
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: shared.name, version: shared.version, type: 'module', exports,
      }));
    }

    const { setupPluginWebSocketServer } = await import(pathToFileURL(join(realtime, 'plugin-ws.js')));
    let report;
    const advertised = new Promise(resolve => { report = resolve; });
    const worker = {
      diagnostics: () => ({ pid: 1 }),
      callWithCompletion: (method, params) => {
        if (method === 'webSocketOpen') report(params.host);
        return { result: Promise.resolve({ status: 426 }), completed: Promise.resolve() };
      },
    };
    const server = new EventEmitter();
    const route = setupPluginWebSocketServer(server, {}, { getWorker: () => worker, isRunning: () => true });
    t.after(() => route.stop());
    server.emit('upgrade', {
      url: '/api/plugins/test.plugin/ws/transport?companyId=00000000-0000-0000-0000-000000000000',
      headers: {},
    }, new PassThrough(), Buffer.alloc(0));
    assert.equal((await advertised).shared, expected);
  });
});
