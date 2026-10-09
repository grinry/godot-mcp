import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { handleEditorPluginTool } from '../build/editor-plugin-tools.js';
import { ToolPolicy } from '../build/tool-policy.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'godot-plugin-tools-'));
  await mkdir(join(root, 'addons/example'), { recursive: true });
  await writeFile(
    join(root, 'project.godot'),
    'config_version=5\n; keep\n[editor_plugins]\nenabled=PackedStringArray("res://addons/other/plugin.cfg") ; comment\n',
  );
  await writeFile(
    join(root, 'addons/example/plugin.cfg'),
    '[plugin]\nname="Example"\ndescription="Fixture"\nauthor="test"\nversion="1"\nscript="plugin.gd"\n',
  );
  await writeFile(join(root, 'addons/example/plugin.gd'), '@tool\nextends EditorPlugin\n');
  return root;
}
const call = (root, name, args = {}, signal) =>
  handleEditorPluginTool(name, { projectPath: root, ...args }, signal);

test('plugin tools preview, enable/disable idempotently and preserve unrelated configuration', async () => {
  const root = await fixture();
  try {
    const original = await readFile(join(root, 'project.godot'), 'utf8');
    const listed = (await call(root, 'get_editor_plugins')).structuredContent;
    assert.equal(listed.plugins.find((item) => item.name === 'Example').configuredEnabled, false);
    assert.equal(
      listed.plugins.find((item) => item.pluginPath.includes('/other/')).configuredEnabled,
      true,
    );
    const preview = (
      await call(root, 'enable_editor_plugin', {
        pluginPath: 'addons/example/plugin.cfg',
        dryRun: true,
      })
    ).structuredContent;
    assert.equal(preview.saved, false);
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), original);
    await assert.rejects(
      call(root, 'enable_editor_plugin', {
        pluginPath: 'addons/example/plugin.cfg',
        expectedHash: 'stale',
      }),
      /changed since preview/,
    );
    const enabled = (
      await call(root, 'enable_editor_plugin', {
        pluginPath: 'res://addons/example/plugin.cfg',
        expectedHash: preview.sourceHash,
      })
    ).structuredContent;
    assert.equal(enabled.configuredEnabled, true);
    assert.equal(enabled.configuredOnly, true);
    assert.equal(enabled.activation, 'editor_reload_required');
    assert.equal(
      (await call(root, 'enable_editor_plugin', { pluginPath: 'addons/example/plugin.cfg' }))
        .structuredContent.changed,
      false,
    );
    assert.match(
      await readFile(join(root, 'project.godot'), 'utf8'),
      /"res:\/\/addons\/other\/plugin.cfg", "res:\/\/addons\/example\/plugin.cfg"\) ; comment/,
    );
    await call(root, 'disable_editor_plugin', { pluginPath: 'addons/example/plugin.cfg' });
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), original);
    assert.equal(
      (await call(root, 'disable_editor_plugin', { pluginPath: 'addons/example/plugin.cfg' }))
        .structuredContent.changed,
      false,
    );
    await assert.rejects(
      call(root, 'enable_editor_plugin', { pluginPath: 'addons/../outside/plugin.cfg' }),
      /pluginPath/,
    );
    await assert.rejects(
      call(root, 'enable_editor_plugin', { pluginPath: 'addons/missing/plugin.cfg' }),
    );
    await assert.rejects(
      call(
        root,
        'enable_editor_plugin',
        { pluginPath: 'addons/example/plugin.cfg' },
        AbortSignal.abort(),
      ),
    );
    await new ToolPolicy([], true).check('get_editor_plugins', { projectPath: root });
    await assert.rejects(
      new ToolPolicy([], true).check('enable_editor_plugin', { projectPath: root }),
      /blocks/,
    );
    // Disabling a stale configured entry does not require its deleted files.
    await call(root, 'disable_editor_plugin', { pluginPath: 'addons/other/plugin.cfg' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin discovery refuses an addons symlink escaping the allowed project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-plugin-link-'));
  const outside = await fixture();
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    await symlink(join(outside, 'addons'), join(root, 'addons'));
    await assert.rejects(call(root, 'get_editor_plugins'), /escapes/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('MCP exposes all plugin tools and their structured results', async () => {
  const root = await fixture();
  const client = new Client({ name: 'plugin-tools-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: process.execPath, GODOT_ALLOWED_ROOTS: root },
    stderr: 'ignore',
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((item) => item.name);
    for (const name of ['get_editor_plugins', 'enable_editor_plugin', 'disable_editor_plugin'])
      assert.ok(names.includes(name));
    for (const name of ['enable_editor_plugin', 'disable_editor_plugin']) {
      const result = await client.callTool({
        name,
        arguments: { projectPath: root, pluginPath: 'addons/example/plugin.cfg' },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.structuredContent.configuredEnabled, name === 'enable_editor_plugin');
    }
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
