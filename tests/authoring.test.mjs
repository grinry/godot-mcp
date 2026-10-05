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
test('real Godot: safe attachment, typed exported references, main scene and reflection', {
  skip: !godot,
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-authoring-'));
  const client = new Client({ name: 'authoring-regression', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  try {
    const project =
      'config_version=5\n; keep comment\n[application]\nconfig/name="Keep me"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
    await writeFile(join(root, 'project.godot'), project);
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene format=3]\n[node name="Root" type="Node2D"]\n[node name="Target" type="Sprite2D" parent="."]\n[node name="Wrong" type="Node" parent="."]\n',
    );
    await writeFile(
      join(root, 'scene.gd'),
      'extends Node2D\n@export var target: Sprite2D\n@export var target_path: NodePath\n',
    );
    await writeFile(join(root, 'wrong.gd'), 'extends Node3D\n');
    await writeFile(join(root, 'broken.gd'), 'extends Node2D\nfunc broken(:\n');
    await writeFile(
      join(root, 'Controller.cs'),
      'using Godot; public partial class Controller : Node2D {}\n',
    );
    await client.connect(transport);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: { projectPath: root, ...args } });
    const initial = await readFile(join(root, 'scene.tscn'), 'utf8');
    for (const scriptPath of ['wrong.gd', 'broken.gd', 'Controller.cs']) {
      assert.equal(
        (await call('attach_script', { scenePath: 'scene.tscn', nodePath: 'root', scriptPath }))
          .isError,
        true,
      );
      assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), initial);
    }
    const attached = await call('attach_script', {
      scenePath: 'scene.tscn',
      nodePath: 'root',
      scriptPath: 'scene.gd',
    });
    assert.notEqual(attached.isError, true, JSON.stringify(attached));
    for (const property of ['target', 'target_path']) {
      const bound = await call('set_node_reference', {
        scenePath: 'scene.tscn',
        nodePath: 'root',
        property,
        targetNodePath: 'root/Target',
      });
      assert.notEqual(bound.isError, true, JSON.stringify(bound));
    }
    const saved = await readFile(join(root, 'scene.tscn'), 'utf8');
    assert.match(saved, /script = ExtResource/);
    assert.match(saved, /target = NodePath\("Target"\)/);
    assert.match(saved, /target_path = NodePath\("Target"\)/);
    await writeFile(
      join(root, 'verify.gd'),
      'extends SceneTree\nfunc _init():\n    var scene = load("res://scene.tscn").instantiate()\n    assert(scene.target == scene.get_node("Target"))\n    assert(scene.get_node(scene.target_path) == scene.target)\n    scene.free()\n    quit(0)\n',
    );
    await promisify(execFile)(
      godot,
      ['--headless', '--path', root, '--script', 'res://verify.gd'],
      { timeout: 10000 },
    );
    assert.equal(
      (
        await call('set_node_reference', {
          scenePath: 'scene.tscn',
          nodePath: 'root',
          property: 'target',
          targetNodePath: 'Wrong',
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), saved);
    const main = await call('set_main_scene', { scenePath: 'res://scene.tscn' });
    assert.notEqual(main.isError, true, JSON.stringify(main));
    const configured = await readFile(join(root, 'project.godot'), 'utf8');
    assert.match(configured, /run\/main_scene="res:\/\/scene.tscn"/);
    assert.equal(configured.replace('run/main_scene="res://scene.tscn"\n', ''), project);
    const reflection = await call('get_class_info', {
      className: 'Node2D',
      section: 'properties',
      filter: 'position',
      limit: 2,
    });
    assert.notEqual(reflection.isError, true, JSON.stringify(reflection));
    const info = JSON.parse(reflection.content[0].text);
    assert.match(info.godotVersion, /^4\./);
    assert.ok(info.entries.some((entry) => entry.name.includes('position')));
    assert.ok(info.entries.length <= 2);
    assert.equal((await call('get_class_info', { className: 'MissingClass' })).isError, true);
    // A non-.NET executable must not strip a C# reference on any mutating path.
    const csScene =
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Controller.cs" id="1"]\n[node name="Root" type="Node2D"]\nscript = ExtResource("1")\n';
    await writeFile(join(root, 'csharp.tscn'), csScene);
    for (const name of ['add_node', 'save_scene', 'update_project_uids']) {
      const result = await call(name, {
        scenePath: 'csharp.tscn',
        nodeType: 'Node2D',
        nodeName: 'Child',
      });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(await readFile(join(root, 'csharp.tscn'), 'utf8'), csScene);
    }
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ClassDB reflection ignores project autoloads in the server working directory', {
  skip: !godot,
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-reflection-autoload-'));
  const client = new Client({ name: 'reflection-isolation', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'build/index.js')],
    cwd: root,
    env: { ...process.env, GODOT_PATH: godot, GODOT_READ_ONLY: 'true' },
    stderr: 'ignore',
  });
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[autoload]\nMarker="*res://marker.gd"\n',
    );
    await writeFile(
      join(root, 'marker.gd'),
      'extends Node\nfunc _init():\n    var file = FileAccess.open("res://executed.txt", FileAccess.WRITE)\n    file.store_string("executed")\n',
    );
    await client.connect(transport);
    const result = await client.callTool({
      name: 'get_class_info',
      arguments: { className: 'Node', limit: 1 },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    await assert.rejects(readFile(join(root, 'executed.txt')), { code: 'ENOENT' });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
