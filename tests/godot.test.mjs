import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const godot = process.env.GODOT_TEST_PATH;
const execute = promisify(execFile);
test('real Godot: scene properties, failure atomicity, ESM project name and validation', {
  skip: !godot,
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-integration-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'regression', version: '1' });
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[application]\nconfig/name="Configured Name"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    const operation = (name, args) =>
      execute(
        godot,
        [
          '--headless',
          '--log-file',
          join(root, 'engine.log'),
          '--path',
          root,
          '--script',
          join(process.cwd(), 'build/scripts/godot_operations.gd'),
          name,
          JSON.stringify(args),
        ],
        { timeout: 15000 },
      );
    const created = await operation('create_scene', {
      scene_path: 'scene.tscn',
      root_node_type: 'Node2D',
    });
    assert.doesNotMatch(created.stderr, /p_owner == this|leaked|still in use/);
    await operation('add_node', {
      scene_path: 'res://scene.tscn',
      node_type: 'Node2D',
      node_name: 'Child',
      properties: { position: [11, 22], z_index: 2 },
    });
    const saved = await readFile(join(root, 'scene.tscn'), 'utf8');
    assert.match(saved, /position = Vector2\(11, 22\)/);
    for (const position of [[1], [1, 'bad'], [1, 2, 3]]) {
      await assert.rejects(
        operation('add_node', {
          scene_path: 'scene.tscn',
          node_type: 'Node2D',
          node_name: 'Invalid',
          properties: { position },
        }),
      );
      assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), saved);
    }
    await client.connect(transport);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: { projectPath: root, ...args } });
    assert.equal(
      JSON.parse((await call('get_project_info')).content[0].text).name,
      'Configured Name',
    );
    assert.equal(
      (
        await call('add_node', {
          scenePath: 'res://scene.tscn',
          nodeType: 'Node2D',
          nodeName: 'ViaMCP',
          properties: { position: [3, 4] },
        })
      ).isError,
      undefined,
    );
    await writeFile(join(root, 'bad.gd'), 'extends Node\nfunc broken(:\n');
    assert.equal((await call('validate_project')).isError, true);
    await writeFile(
      join(root, 'bad.gd'),
      'extends Node\nfunc _ready():\n    print("test completed")\n    get_tree().quit(0)\n',
    );
    await writeFile(
      join(root, 'test.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://bad.gd" id="1"]\n[node name="Test" type="Node"]\nscript = ExtResource("1")\n',
    );
    const result = await call('run_scene_test', { scenePath: 'res://test.tscn', timeoutMs: 10000 });
    assert.equal(JSON.parse(result.content[0].text).passed, true, result.content[0].text);
    assert.equal((await call('validate_project')).isError, false);
    assert.equal((await call('run_scene')).isError, true);
    assert.equal((await call('run_scene', { scenePath: '../test.tscn' })).isError, true);
    assert.equal(
      (await call('export_project', { preset: 'Missing', outputPath: 'out.pck' })).isError,
      true,
    );
    await call('run_scene', { scenePath: 'test.tscn', headless: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      JSON.parse((await call('get_debug_output')).content[0].text).output.includes(
        'test completed',
      ),
    );

    const uids = await call('update_project_uids');
    assert.notEqual(uids.isError, true, JSON.stringify(uids));
    assert.match(uids.content[0].text, /Scenes successfully saved: [1-9]/);
    assert.match(await readFile(join(root, 'bad.gd.uid'), 'utf8'), /^uid:\/\//);
    if (process.env.GODOT_TEST_RENDER === 'true') {
      assert.notEqual((await call('launch_editor')).isError, true);
      assert.equal(JSON.parse((await call('view_log')).content[0].text).running, true);
      assert.equal((await call('view_log', { lineCount: 0 })).isError, true);
      await call('quit_godot');
      assert.equal(JSON.parse((await call('view_log')).content[0].text).running, false);
    }
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real renderer: capture returns PNG pixels without project artifacts', {
  skip: !godot || process.env.GODOT_TEST_RENDER !== 'true',
  timeout: 20000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-render-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'renderer-regression', version: '1' });
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[display]\nwindow/size/viewport_width=256\nwindow/size/viewport_height=128\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await writeFile(
      join(root, 'image.tscn'),
      '[gd_scene format=3]\n[node name="Color" type="ColorRect"]\noffset_right = 256.0\noffset_bottom = 128.0\ncolor = Color(1, 0, 0, 1)\n',
    );
    await client.connect(transport);
    const result = await client.callTool({
      name: 'capture_scene_screenshot',
      arguments: { projectPath: root, scenePath: 'image.tscn', timeoutMs: 10000 },
    });
    assert.equal(result.content[0].type, 'image', JSON.stringify(result));
    const png = Buffer.from(result.content[0].data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 128);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
