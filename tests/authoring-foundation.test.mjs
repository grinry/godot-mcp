import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { handleResourceTool } from '../build/resource-tools.js';

const godot = process.env.GODOT_TEST_PATH;
const run = promisify(execFile);
const data = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

test('resource writes reject stale previews, external edits and cancellation; creation never overwrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-resource-atomic-'));
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    for (const scenario of ['external', 'abort', 'create_race']) {
      const target = join(root, 'shape.tres');
      await rm(target, { force: true });
      if (scenario !== 'create_race') await writeFile(target, 'original');
      const controller = new AbortController();
      const runner = {
        run: async (_command, args) => {
          const params = JSON.parse(args.at(-1));
          await writeFile(params.outputPath, 'edited');
          if (scenario === 'abort') controller.abort();
          else await writeFile(target, 'external');
          return {
            output: ['GODOT_MCP_RESULT {"className":"RectangleShape2D","success":true}'],
            errors: [],
            exitCode: 0,
            timedOut: false,
            truncated: false,
          };
        },
      };
      await assert.rejects(
        handleResourceTool(
          scenario === 'create_race' ? 'create_resource' : 'set_resource_properties',
          {
            projectPath: root,
            resourcePath: 'shape.tres',
            className: 'RectangleShape2D',
            properties: { size: [2, 3] },
          },
          'fake',
          'scripts',
          runner,
          controller.signal,
        ),
      );
      assert.equal(await readFile(target, 'utf8'), scenario === 'abort' ? 'original' : 'external');
      assert.ok(!(await readdir(root)).some((name) => name.startsWith('.godot-mcp-')));
    }
    const untouched = { run: () => assert.fail('Invalid input must not invoke Godot') };
    await assert.rejects(
      handleResourceTool(
        'set_resource_properties',
        {
          projectPath: root,
          resourcePath: 'shape.tres',
          properties: { size: [1, 2] },
          expectedHash: 'stale',
        },
        'fake',
        'scripts',
        untouched,
      ),
      /changed since preview/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scene instancing/duplication and resource authoring preserve saves and refuse invalid edits', {
  skip: !godot,
  timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-authoring-foundation-'));
  const outside = await mkdtemp(join(tmpdir(), 'godot-resource-outside-'));
  const client = new Client({ name: 'authoring-foundation', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    await writeFile(
      join(root, 'subtree.gd'),
      'extends Node2D\n@export var target_path: NodePath\n@export var target: Node\nfunc receive():\n    pass\n',
    );
    const source =
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://subtree.gd" id="1"]\n[node name="Root" type="Node"]\n[node name="Original" type="Node2D" parent="." node_paths=PackedStringArray("target") groups=["actors"]]\nscript = ExtResource("1")\ntarget_path = NodePath("Child")\ntarget = NodePath("Child")\n[node name="Child" type="Node2D" parent="Original"]\nposition = Vector2(12, 34)\n[node name="Other" type="Node" parent="."]\n[connection signal="renamed" from="Original/Child" to="Original" method="receive"]\n';
    await writeFile(join(root, 'scene.tscn'), source);
    await writeFile(
      join(root, 'prefab.tscn'),
      '[gd_scene format=3]\n[node name="Prefab" type="Node2D"]\n[node name="Body" type="Node2D" parent="."]\nposition = Vector2(5, 6)\n',
    );
    // Import script metadata before asking ResourceLoader to preserve typed node exports.
    await run(godot, ['--headless', '--editor', '--path', root, '--import'], { timeout: 20000 });
    await client.connect(transport);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: { projectPath: root, ...args } });
    const preview = data(
      await call('duplicate_node', {
        scenePath: 'scene.tscn',
        nodePath: 'Original',
        newName: 'Copy',
        dryRun: true,
      }),
    );
    assert.equal(preview.saved, false);
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), source);
    data(
      await call('modify_scene', {
        scene_path: 'scene.tscn',
        expected_hash: preview.sourceHash,
        operations: [
          { op: 'duplicate_node', node_path: 'Original', new_name: 'Copy' },
          {
            op: 'instance_scene',
            node_path: '.',
            new_name: 'Prefab',
            instance_scene_path: 'prefab.tscn',
          },
          { op: 'set_properties', nodePath: 'Copy/Child', properties: { position: [56, 78] } },
        ],
      }),
    );
    const info = data(await call('get_scene_info', { scenePath: 'scene.tscn' }));
    assert.ok(
      info.nodes.some(
        (node) => node.path === 'Prefab' && node.instancePath === 'res://prefab.tscn',
      ),
    );
    await writeFile(
      join(root, 'verify.gd'),
      'extends SceneTree\nfunc _init():\n    var scene = load("res://scene.tscn").instantiate()\n    var copy = scene.get_node("Copy")\n    assert(copy.target == copy.get_node("Child"))\n    assert(copy.get_node(copy.target_path) == copy.get_node("Child"))\n    assert(copy.get_node("Child").is_connected("renamed", copy.receive))\n    assert(not copy.get_node("Child").is_connected("renamed", scene.get_node("Original").receive))\n    assert(copy.is_in_group("actors"))\n    assert(copy.get_node("Child").owner == scene)\n    assert(copy.get_node("Child").position == Vector2(56, 78))\n    assert(scene.get_node("Prefab/Body").position == Vector2(5, 6))\n    assert(scene.get_node("Prefab").owner == scene)\n    scene.free()\n    quit(0)\n',
    );
    const verified = await run(
      godot,
      ['--headless', '--path', root, '--script', 'res://verify.gd'],
      { timeout: 10000 },
    );
    assert.doesNotMatch(verified.stderr, /SCRIPT ERROR|ERROR:/);
    const saved = await readFile(join(root, 'scene.tscn'), 'utf8');
    for (const args of [
      { nodePath: '.', newName: 'Recursive', instanceScenePath: 'scene.tscn' },
      { nodePath: '.', newName: 'Prefab', instanceScenePath: 'prefab.tscn' },
      { nodePath: 'Prefab/Body', newName: 'Inside', instanceScenePath: 'prefab.tscn' },
      { nodePath: '.', newName: 'Invalid/Name', instanceScenePath: 'prefab.tscn' },
      { nodePath: '.', newName: 'Outside', instanceScenePath: '../prefab.tscn' },
    ]) {
      assert.equal(
        (await call('instance_scene', { scenePath: 'scene.tscn', ...args })).isError,
        true,
      );
      assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), saved);
    }
    data(
      await call('set_node_properties', {
        scenePath: 'scene.tscn',
        nodePath: 'Original',
        properties: { target_path: '../Other' },
      }),
    );
    const referenced = await readFile(join(root, 'scene.tscn'), 'utf8');
    assert.equal(
      (
        await call('duplicate_node', {
          scenePath: 'scene.tscn',
          nodePath: 'Original',
          newName: 'Unsafe',
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), referenced);
    const uniqueSource =
      '[gd_scene format=3]\n[node name="Root" type="Node"]\n[node name="Unique" type="Node" parent="."]\nunique_name_in_owner = true\n';
    await writeFile(join(root, 'unique.tscn'), uniqueSource);
    assert.equal(
      (
        await call('duplicate_node', {
          scenePath: 'unique.tscn',
          nodePath: 'Unique',
          newName: 'Copy',
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(join(root, 'unique.tscn'), 'utf8'), uniqueSource);
    for (const extension of ['tres', 'res']) {
      const path = `shape.${extension}`;
      const args = {
        resourcePath: path,
        className: 'RectangleShape2D',
        properties: { size: { type: 'Vector2', value: [20, 30] } },
      };
      assert.equal(data(await call('create_resource', { ...args, dryRun: true })).saved, false);
      assert.ok(!(await readdir(root)).includes(path));
      data(await call('create_resource', args));
      const original = await readFile(join(root, path));
      const uidBefore = (await call('get_uid', { filePath: path })).content[0].text;
      assert.equal((await call('create_resource', args)).isError, true);
      const inspected = data(await call('get_resource_info', { resource_path: path }));
      assert.deepEqual(
        inspected.properties.find((item) => item.name === 'size').value.value,
        [20, 30],
      );
      assert.equal(
        data(
          await call('set_resource_properties', {
            resourcePath: path,
            properties: { size: [40, 50] },
            dryRun: true,
          }),
        ).saved,
        false,
      );
      assert.deepEqual(await readFile(join(root, path)), original);
      data(
        await call('set_resource_properties', {
          resourcePath: path,
          properties: { size: [40, 50] },
          expectedHash: inspected.sourceHash,
        }),
      );
      const after = await readFile(join(root, path));
      assert.equal((await call('get_uid', { filePath: path })).content[0].text, uidBefore);
      for (const properties of [
        { size: 'bad' },
        { script: null },
        { no_such_property: true },
        { size: [60, 70], no_such_property: true },
      ]) {
        assert.equal(
          (await call('set_resource_properties', { resourcePath: path, properties })).isError,
          true,
        );
        assert.deepEqual(await readFile(join(root, path)), after);
      }
      assert.equal(
        (
          await call('set_resource_properties', {
            resourcePath: path,
            properties: { size: [1, 2] },
            expectedHash: inspected.sourceHash,
          })
        ).isError,
        true,
      );
    }
    data(
      await call('create_resource', {
        resourcePath: 'material.tres',
        className: 'StandardMaterial3D',
        properties: { albedo_color: { type: 'Color', value: [0.2, 0.4, 0.6, 1] } },
      }),
    );
    data(
      await call('create_resource', {
        resourcePath: 'mesh.tres',
        className: 'BoxMesh',
        properties: { material: { type: 'Resource', path: 'res://material.tres' } },
      }),
    );
    const mesh = data(await call('get_resource_info', { resourcePath: 'mesh.tres' }));
    assert.equal(
      mesh.properties.find((item) => item.name === 'material').value.path,
      'res://material.tres',
    );
    await writeFile(
      join(outside, 'outside.tres'),
      '[gd_resource type="Resource" format=3]\n[resource]\n',
    );
    await symlink(join(outside, 'outside.tres'), join(root, 'escape.tres'));
    assert.equal(
      (
        await call('set_resource_properties', {
          resourcePath: 'mesh.tres',
          properties: { material: { type: 'Resource', path: 'res://escape.tres' } },
        })
      ).isError,
      true,
    );
    for (const className of ['Node', 'GDScript', 'PackedScene', 'Missing'])
      assert.equal(
        (await call('create_resource', { resourcePath: 'invalid.tres', className })).isError,
        true,
      );
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('.godot-mcp-')));
  } finally {
    await client.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
