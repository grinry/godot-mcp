import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const version = '2026-07-28';
test('modern discover/envelopes and legacy handshake use their own wire format', {
  timeout: 10000,
}, async () => {
  for (const modern of [true, false]) {
    const child = spawn(process.execPath, ['build/index.js'], {
      env: { ...process.env, GODOT_PATH: process.execPath },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const readers = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      readers.get(message.id)?.(message);
    });
    const request = (id, method, params) =>
      new Promise((resolve) => {
        readers.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    try {
      if (modern) {
        const discovered = await request(1, 'server/discover', {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        });
        assert.equal(discovered.error, undefined, JSON.stringify(discovered));
        assert.equal(discovered.result.resultType, 'complete');
        assert.ok(JSON.stringify(discovered.result).includes(version));
        assert.ok(discovered.result._meta['io.modelcontextprotocol/serverInfo']);
        const listed = await request(2, 'tools/list', {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        });
        assert.equal(listed.error, undefined, JSON.stringify(listed));
        assert.equal(listed.result.resultType, 'complete');
        assert.ok(listed.result.tools.some((tool) => tool.name === 'get_class_info'));
        const invalidVersion = await request(3, 'tools/list', {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2099-01-01',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        });
        assert.equal(invalidVersion.error.code, -32022);
      } else {
        const initialized = await request(1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-wire', version: '1' },
        });
        assert.equal(initialized.result.protocolVersion, '2025-11-25');
        assert.equal(initialized.result.resultType, undefined);
        assert.match(initialized.result.instructions, /trusted Godot projects/);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
        const listed = await request(2, 'tools/list', {});
        assert.equal(listed.result.resultType, undefined);
        assert.ok(listed.result.tools.some((tool) => tool.name === 'attach_script'));
      }
    } finally {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null)
        await new Promise((resolve) => {
          child.once('exit', resolve);
          setTimeout(() => child.kill('SIGKILL'), 2000).unref();
        });
    }
  }
});

test('official modern client uses explicit independent sessions and rejects stale handles', {
  skip: !process.env.GODOT_TEST_PATH,
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-modern-session-'));
  const client = new Client(
    { name: 'modern-regression', version: '1' },
    { versionNegotiation: { mode: { pin: version } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: process.env.GODOT_TEST_PATH },
    stderr: 'ignore',
  });
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[application]\nrun/main_scene="res://scene.tscn"\n',
    );
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene format=3]\n[node name="Root" type="Node2D"]\n',
    );
    await client.connect(transport);
    await client.listTools();
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const sessions = [];
    for (let index = 0; index < 2; index++) {
      const launched = await call('start_debug_session', { projectPath: root, headless: true });
      assert.notEqual(launched.isError, true, JSON.stringify(launched));
      sessions.push(JSON.parse(launched.content.at(-1).text).sessionId);
    }
    assert.notEqual(sessions[0], sessions[1]);
    assert.equal((await call('get_runtime_tree')).isError, true);
    for (const sessionId of sessions) {
      const tree = await call('get_runtime_tree', { sessionId, maxNodes: 1 });
      assert.notEqual(tree.isError, true, JSON.stringify(tree));
      assert.equal(JSON.parse(tree.content[0].text).nodes[0].path, '.');
    }
    await call('close_session', { sessionId: sessions[0] });
    assert.equal((await call('get_debug_output', { sessionId: sessions[0] })).isError, true);
    assert.equal(
      JSON.parse((await call('get_debug_output', { sessionId: sessions[1] })).content[0].text)
        .running,
      true,
    );
    await call('close_session', { sessionId: sessions[1] });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
