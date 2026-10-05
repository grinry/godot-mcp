import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { diagnosticCounts, parseDiagnostics } from '../build/diagnostics.js';
import { projectOverview } from '../build/project-overview.js';
import { handleSceneTool } from '../build/scene-tools.js';
import { ToolPolicy } from '../build/tool-policy.js';
import { ToolRegistry } from '../build/tool-registry.js';
import { toolSpecifications } from '../build/tool-specifications.js';

const godot = process.env.GODOT_TEST_PATH;
const run = promisify(execFile);
const data = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

test('diagnostics associate Godot stack locations and preserve unknown locations', () => {
  const diagnostics = parseDiagnostics([
    'SCRIPT ERROR: Parse Error: Unexpected token',
    '   at: GDScript::reload (res://scripts/player.gd:12)',
    'WARNING: unused variable',
    '  at: res://scripts/player.gd:20',
    'ERROR: Cannot open file',
    'ordinary output',
    'SCRIPT ERROR: Invalid call',
    '   GDScript backtrace (most recent call first):',
    '       [0] _ready (res://enemy.gd:7)',
  ]);
  assert.deepEqual(diagnostics, [
    {
      file: 'res://scripts/player.gd',
      line: 12,
      severity: 'error',
      message: 'Parse Error: Unexpected token',
    },
    { file: 'res://scripts/player.gd', line: 20, severity: 'warning', message: 'unused variable' },
    { file: null, line: null, severity: 'error', message: 'Cannot open file' },
    { file: 'res://enemy.gd', line: 7, severity: 'error', message: 'Invalid call' },
  ]);
  assert.deepEqual(diagnosticCounts(diagnostics), { errors: 3, warnings: 1 });
  assert.deepEqual(
    parseDiagnostics(['ERROR: Cannot open file', 'Loaded checkpoint res://player.gd:42']),
    [{ file: null, line: null, severity: 'error', message: 'Cannot open file' }],
  );
  assert.equal(
    parseDiagnostics(['ERROR: native error', ' at: reload (scene/resources/file.cpp:42)'])[0].file,
    null,
  );
});

test('overview discovers source declarations and dependencies without running scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-overview-'));
  try {
    await mkdir(join(root, 'addons'));
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nState="*res://state.gd"\n[input]\njump={\n"deadzone": 0.5,\n"events": []\n}\n[editor_plugins]\nenabled=PackedStringArray("res://addons/example/plugin.cfg")\n',
    );
    await writeFile(join(root, 'state.gd'), 'class_name State\nextends Node\n');
    await writeFile(
      join(root, 'main.tscn'),
      '[gd_scene format=3]\n[ext_resource type="Script" path="res://state.gd" id="1"]\n[node name="Root" type="Node"]\n',
    );
    const info = await projectOverview({ projectPath: root });
    assert.equal(info.mainScene, '"res://main.tscn"');
    assert.equal(info.autoloads[0].name, 'State');
    assert.equal(info.inputActions[0].name, 'jump');
    assert.match(info.inputActions[0].expression, /deadzone/);
    assert.equal(info.customClasses[0].name, 'State');
    assert.deepEqual(info.dependencies[0].references, ['res://state.gd']);
    assert.equal(info.truncated, false);
    assert.equal((await projectOverview({ projectPath: root, limit: 1 })).truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real Godot: inspect, preview, transactional edits, references and targeted diagnostics', {
  skip: !godot,
  timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-scene-workflows-'));
  const client = new Client({ name: 'project-workflows', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await writeFile(
      join(root, 'controller.gd'),
      'extends Node2D\n@export var target_path: NodePath = NodePath("Player")\n@export var health: int = 10\n@export var node_path: String = "initial"\nsignal changed(value: Vector2)\nsignal enemy_changed(value: WorkflowEnemy)\nfunc receive_node(_value: Node):\n    pass\nfunc incompatible(_value: Node):\n    pass\nfunc compatible(_value: Vector2):\n    pass\nfunc receive():\n    pass\n',
    );
    await writeFile(join(root, 'enemy.gd'), 'class_name WorkflowEnemy\nextends Node\n');
    const scene =
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://controller.gd" id="1"]\n[node name="Root" type="Node2D"]\nscript = ExtResource("1")\ntarget_path = NodePath("Player")\n[node name="Player" type="Node2D" parent="." groups=["actors"]]\nposition = Vector2(1, 2)\n[node name="Container" type="Node2D" parent="."]\n[node name="Disposable" type="Node" parent="."]\n';
    await writeFile(join(root, 'scene.tscn'), scene);
    await run(godot, ['--headless', '--path', root, '--editor', '--quit'], { timeout: 10000 });
    await client.connect(transport);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: { projectPath: root, scenePath: 'scene.tscn', ...args } });
    const listed = (await client.listTools()).tools;
    for (const name of [
      'get_scene_info',
      'set_node_properties',
      'modify_scene',
      'get_project_overview',
      'get_node_properties',
      'step_frames',
    ])
      assert.ok(listed.some((tool) => tool.name === name));
    const inspected = data(await call('get_scene_info'));
    assert.equal(inspected.nodes.length, 4);
    assert.ok(
      inspected.nodes[0].exportedProperties.some(
        (item) => item.name === 'health' && item.default === 10,
      ),
    );
    assert.ok(inspected.nodes[0].properties.some((property) => property.name === 'script'));
    assert.deepEqual(inspected.nodes[1].groups, ['actors']);
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), scene);
    assert.equal(
      (
        await call('modify_scene', {
          operations: [
            {
              op: 'connect_signal',
              nodePath: '.',
              signal: 'changed',
              targetNodePath: '.',
              method: 'incompatible',
            },
          ],
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), scene);
    const operations = [
      {
        op: 'set_properties',
        nodePath: 'Player',
        properties: { position: { type: 'Vector2', value: [30, 40] } },
      },
      { op: 'rename_node', nodePath: 'Player', newName: 'Hero' },
      { op: 'reparent_node', nodePath: 'Hero', parentNodePath: 'Container' },
      { op: 'add_group', nodePath: 'Container/Hero', group: 'controllable' },
      {
        op: 'connect_signal',
        nodePath: 'Container/Hero',
        signal: 'renamed',
        targetNodePath: '.',
        method: 'receive',
      },
      { op: 'remove_node', nodePath: 'Disposable' },
      {
        op: 'set_properties',
        nodePath: '.',
        properties: { health: 25, node_path: 'unchanged_name' },
      },
      {
        op: 'connect_signal',
        nodePath: '.',
        signal: 'changed',
        targetNodePath: '.',
        method: 'compatible',
      },
      {
        op: 'connect_signal',
        nodePath: '.',
        signal: 'enemy_changed',
        targetNodePath: '.',
        method: 'receive_node',
      },
    ];
    const preview = data(await call('modify_scene', { operations, dryRun: true }));
    assert.equal(preview.saved, false);
    assert.equal(preview.sourceHash, inspected.sourceHash);
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), scene);
    const modified = data(
      await call('modify_scene', { operations, expectedHash: preview.sourceHash }),
    );
    assert.equal(modified.saved, true);
    const saved = await readFile(join(root, 'scene.tscn'), 'utf8');
    assert.match(saved, /script = ExtResource/);
    assert.match(saved, /target_path = NodePath\("Container\/Hero"\)/);
    const after = data(await call('get_scene_info'));
    assert.ok(
      after.nodes.some((node) => node.path === 'Container/Hero'),
      JSON.stringify(after),
    );
    assert.ok(after.connections.some((connection) => connection.signal === 'renamed'));
    assert.ok(after.connections.some((connection) => connection.signal === 'changed'));
    assert.ok(after.connections.some((connection) => connection.signal === 'enemy_changed'));
    assert.ok(
      after.nodes[0].properties.some(
        (item) => item.name === 'node_path' && item.value === 'unchanged_name',
      ),
    );
    assert.equal(
      (await call('modify_scene', { operations, expectedHash: preview.sourceHash })).isError,
      true,
    );
    for (const invalid of [
      [{ op: 'remove_node', nodePath: 'Container/Hero' }],
      [
        { op: 'set_properties', nodePath: '.', properties: { health: 99 } },
        { op: 'rename_node', nodePath: 'missing', newName: 'No' },
      ],
      [{ op: 'set_properties', nodePath: '.', properties: { script: null } }],
      [{ op: 'reparent_node', nodePath: 'Container', parentNodePath: 'Container/Hero' }],
      [{ op: 'set_properties', nodePath: '.', properties: { health: 'bad' } }],
      [{ op: 'set_properties', nodePath: '.', properties: { target_path: '../outside' } }],
    ]) {
      assert.equal((await call('modify_scene', { operations: invalid })).isError, true);
      assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), saved);
    }
    data(await call('set_node_properties', { node_path: '.', properties: { health: 50 } }));
    data(
      await call('modify_scene', {
        operations: [{ op: 'rename_node', node_path: 'Container/Hero', new_name: 'Renamed' }],
        dry_run: true,
      }),
    );
    const hash = data(await call('get_scene_info')).sourceHash;
    const parallel = await Promise.all(
      [51, 52].map((health) =>
        call('set_node_properties', { nodePath: '.', properties: { health }, expectedHash: hash }),
      ),
    );
    assert.equal(parallel.filter((result) => result.isError === true).length, 1);
    data(await call('set_node_properties', { nodePath: '.', properties: { health: 50 } }));
    await writeFile(
      join(root, 'verify.gd'),
      'extends SceneTree\nfunc _init():\n    var scene = load("res://scene.tscn").instantiate()\n    assert(scene.health == 50)\n    assert(scene.get_node(scene.target_path) == scene.get_node("Container/Hero"))\n    assert(scene.get_node("Container/Hero").position == Vector2(30, 40))\n    assert(scene.get_node("Container/Hero").is_in_group("controllable"))\n    assert(scene.get_node("Container/Hero").is_connected("renamed", scene.receive))\n    scene.free()\n    quit(0)\n',
    );
    await run(godot, ['--headless', '--path', root, '--script', 'res://verify.gd'], {
      timeout: 10000,
    });
    await writeFile(
      join(root, 'binary.gd'),
      'extends SceneTree\nfunc _init():\n    ResourceSaver.save(load("res://scene.tscn"), "res://binary.scn")\n    quit(0)\n',
    );
    await run(godot, ['--headless', '--path', root, '--script', 'res://binary.gd'], {
      timeout: 10000,
    });
    const binary = data(await call('get_scene_info', { scenePath: 'binary.scn' }));
    data(
      await call('set_node_properties', {
        scenePath: 'binary.scn',
        nodePath: '.',
        properties: { health: 75 },
        expectedHash: binary.sourceHash,
      }),
    );
    const binaryAfter = data(await call('get_scene_info', { scenePath: 'binary.scn' }));
    assert.ok(
      binaryAfter.nodes[0].properties.some((item) => item.name === 'health' && item.value === 75),
    );
    await writeFile(join(root, 'broken.gd'), 'extends Node\nfunc broken(:\n');
    const valid = data(await call('validate_project', { scripts: ['controller.gd'] }));
    assert.equal(valid.valid, true);
    assert.equal(valid.checked, 1);
    const invalid = await call('validate_project', { pattern: 'broken.gd' });
    assert.equal(invalid.isError, true);
    const report = JSON.parse(invalid.content[0].text);
    assert.ok(report.counts.errors > 0);
    assert.ok(
      report.diagnostics.some((item) => item.file === 'res://broken.gd' && item.line === 2),
    );
    assert.equal((await call('validate_project', { pattern: 'missing*.gd' })).isError, true);
    assert.equal((await call('validate_project', { scripts: ['../bad.gd'] })).isError, true);
    // Inherited and instanced scenes are reported but their node edits are refused.
    await writeFile(
      join(root, 'inherited.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://scene.tscn" id="1"]\n[node name="Inherited" instance=ExtResource("1")]\n',
    );
    const inherited = data(await call('get_scene_info', { scenePath: 'inherited.tscn' }));
    assert.match(inherited.baseScene, /scene.tscn/);
    await writeFile(
      join(root, 'instance.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="PackedScene" path="res://scene.tscn" id="1"]\n[node name="Root" type="Node"]\n[node name="Instance" parent="." instance=ExtResource("1")]\n',
    );
    const instanceBytes = await readFile(join(root, 'instance.tscn'), 'utf8');
    assert.equal(
      (
        await call('set_node_properties', {
          scenePath: 'instance.tscn',
          nodePath: 'Instance/Container/Hero',
          properties: { position: [0, 0] },
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(join(root, 'instance.tscn'), 'utf8'), instanceBytes);
    const detached = data(
      await call('modify_scene', {
        operations: [
          {
            op: 'disconnect_signal',
            nodePath: 'Container/Hero',
            signal: 'renamed',
            targetNodePath: '.',
            method: 'receive',
          },
          { op: 'remove_group', nodePath: 'Container/Hero', group: 'controllable' },
          { op: 'set_properties', nodePath: '.', properties: { target_path: '' } },
          { op: 'remove_node', nodePath: 'Container/Hero' },
        ],
        dryRun: true,
      }),
    );
    assert.equal(detached.saved, false);
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('.godot-mcp-')));
    const inheritedBytes = await readFile(join(root, 'inherited.tscn'), 'utf8');
    assert.equal(
      (
        await call('set_node_properties', {
          scenePath: 'inherited.tscn',
          nodePath: '.',
          properties: { health: 5 },
        })
      ).isError,
      true,
    );
    assert.equal(await readFile(join(root, 'inherited.tscn'), 'utf8'), inheritedBytes);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real Godot: paused physics/process stepping and bounded runtime properties', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-stepping-'));
  const client = new Client({ name: 'stepping', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[application]\nrun/main_scene="res://scene.tscn"\n',
    );
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://counter.gd" id="1"]\n[node name="Root" type="Node2D"]\nscript = ExtResource("1")\n',
    );
    await writeFile(
      join(root, 'counter.gd'),
      'extends Node2D\nvar physics_count = 0\nvar process_count = 0\nfunc _physics_process(_delta):\n    physics_count += 1\n    position.x += 1\nfunc _process(_delta):\n    process_count += 1\n',
    );
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    data(await call('start_debug_session', { projectPath: root, headless: true }));
    assert.equal((await call('step_frames', { frames: 1 })).isError, true);
    data(await call('set_debug_pause', { paused: true }));
    const values = async () =>
      data(
        await call('get_node_properties', {
          nodePath: '.',
          properties: ['physics_count', 'process_count', 'position'],
        }),
      ).properties;
    const before = await values();
    data(await call('step_frames', { frames: 10, kind: 'physics' }));
    const after = await values();
    assert.equal(after.physics_count.value - before.physics_count.value, 10);
    assert.equal(after.position.value.value[0] - before.position.value.value[0], 10);
    data(await call('step_frames', { frames: 3, kind: 'process' }));
    const processed = await values();
    assert.equal(processed.process_count.value - after.process_count.value, 3);
    assert.deepEqual(await values(), processed);
    assert.equal(
      (await call('get_node_properties', { nodePath: '.', properties: ['missing'] })).isError,
      true,
    );
    assert.equal(
      (await call('get_node_properties', { nodePath: '../outside', properties: ['name'] })).isError,
      true,
    );
    assert.equal((await call('step_frames', { frames: 0 })).isError, true);
    data(await call('stop_project'));
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('tool registry and read-only policy share metadata for every advertised tool', async () => {
  const registry = new ToolRegistry(
    toolSpecifications.map(({ access, session, handler: _handler, ...tool }) => ({
      tool,
      access,
      session,
      handle: async () => ({ content: [] }),
    })),
  );
  const listed = registry.list();
  assert.equal(new Set(listed.map((tool) => tool.name)).size, listed.length);
  const policy = new ToolPolicy([], true);
  for (const tool of listed) {
    const specification = registry.get(tool.name);
    assert.equal(tool.annotations.readOnlyHint, specification.access === 'read');
    assert.equal('sessionId' in tool.inputSchema.properties, specification.session !== 'none');
    if (specification.access === 'execute')
      await assert.rejects(policy.check(tool.name, {}), /READ_ONLY/);
    else await policy.check(tool.name, {});
  }
});

test('scene transaction refuses external changes/cancellation and cleans temporary resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-scene-concurrency-'));
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    const scene = join(root, 'scene.tscn');
    for (const scenario of ['external', 'abort', 'engine_error']) {
      await writeFile(scene, 'original');
      const controller = new AbortController();
      const runner = {
        run: async (_command, args) => {
          const params = JSON.parse(args.at(-1));
          await writeFile(params.outputPath, 'edited');
          if (scenario === 'external') await writeFile(scene, 'external edit');
          if (scenario === 'abort') controller.abort();
          return {
            output: ['GODOT_MCP_RESULT {"success":true}'],
            errors: scenario === 'engine_error' ? ['ERROR: failed save'] : [],
            exitCode: 0,
            timedOut: false,
            truncated: false,
            snapshot() {
              return { output: this.output, errors: this.errors, exitCode: this.exitCode };
            },
          };
        },
      };
      await assert.rejects(
        handleSceneTool(
          'set_node_properties',
          {
            projectPath: root,
            scenePath: 'scene.tscn',
            nodePath: '.',
            properties: { visible: true },
          },
          'fake-godot',
          'scripts',
          runner,
          controller.signal,
        ),
      );
      assert.equal(
        await readFile(scene, 'utf8'),
        scenario === 'external' ? 'external edit' : 'original',
      );
      assert.ok(!(await readdir(root)).some((name) => name.startsWith('.godot-mcp-')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parallel scene transactions without hashes preserve both edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-scene-queue-'));
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    const scene = join(root, 'scene.tscn');
    await writeFile(scene, '{}');
    let active = 0;
    const runner = {
      run: async (_command, args) => {
        active += 1;
        assert.equal(active, 1, 'Scene writers must not overlap');
        const params = JSON.parse(args.at(-1));
        const previous = JSON.parse(await readFile(scene, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        await writeFile(
          params.outputPath,
          JSON.stringify({ ...previous, ...params.operations[0].properties }),
        );
        active -= 1;
        return {
          output: ['GODOT_MCP_RESULT {"success":true}'],
          errors: [],
          exitCode: 0,
          timedOut: false,
          truncated: false,
        };
      },
    };
    const results = await Promise.all(
      [{ health: 25 }, { speed: 12 }].map((properties) =>
        handleSceneTool(
          'set_node_properties',
          { projectPath: root, scenePath: 'scene.tscn', nodePath: '.', properties },
          'fake-godot',
          'scripts',
          runner,
        ),
      ),
    );
    assert.ok(results.every((result) => result.structuredContent.saved));
    assert.deepEqual(JSON.parse(await readFile(scene, 'utf8')), { health: 25, speed: 12 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
