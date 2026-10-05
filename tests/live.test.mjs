import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inputParameters } from '../build/workflow-tools.js';

const godot = process.env.GODOT_TEST_PATH;
const render = process.env.GODOT_TEST_RENDER === 'true';
test('input parameters reject malformed and unbounded events', () => {
  for (const args of [
    { kind: 'key', keycode: NaN },
    { kind: 'action', action: 'ui_accept', pressed: 'true' },
    { kind: 'mouse_motion', x: Infinity, y: 0 },
    { kind: 'unknown' },
  ])
    assert.throws(() => inputParameters(args));
  assert.deepEqual(inputParameters({ kind: 'action', action: 'ui_accept' }), {
    kind: 'action',
    action: 'ui_accept',
    pressed: true,
    strength: 1,
  });
});
test('live session receives input, captures changed state while paused and cleans up', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-live-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'live-regression', version: '1' });
  try {
    const project =
      'config_version=5\n[application]\nrun/main_scene="res://scene.tscn"\n[display]\nwindow/size/viewport_width=256\nwindow/size/viewport_height=128\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
    const script =
      'extends ColorRect\nfunc _input(event):\n    if event is InputEventKey:\n        print("key event ", event.keycode)\n    if event is InputEventMouseButton:\n        print("mouse event ", event.button_index)\n    if event is InputEventMouseMotion:\n        print("motion event ", event.position.x)\n    if event.is_action_pressed("ui_accept"):\n        color = Color(0, 0, 1, 1)\n        print("received action")\n';
    const scene =
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Color" type="ColorRect"]\noffset_right = 256.0\noffset_bottom = 128.0\ncolor = Color(1, 0, 0, 1)\nscript = ExtResource("1")\n';
    await writeFile(join(root, 'project.godot'), project);
    await writeFile(join(root, 'scene.gd'), script);
    await writeFile(join(root, 'scene.tscn'), scene);
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    assert.equal((await call('capture_screenshot')).isError, true);
    const started = await call('start_debug_session', { projectPath: root, headless: !render });
    assert.notEqual(started.isError, true, JSON.stringify(started));
    const before = await call('capture_screenshot');
    assert.equal(before.content[0].type, render ? 'image' : 'text');
    assert.equal(
      (await call('simulate_input', { kind: 'action', action: 'missing' })).isError,
      true,
    );
    assert.notEqual(
      (await call('simulate_input', { kind: 'action', action: 'ui_accept' })).isError,
      true,
    );
    assert.notEqual(
      (await call('simulate_input', { kind: 'action', action: 'ui_accept', pressed: false }))
        .isError,
      true,
    );
    for (const event of [
      { kind: 'key', keycode: 32, pressed: true },
      { kind: 'key', keycode: 32, pressed: false },
      { kind: 'mouse_button', button: 1, x: 10, y: 20, pressed: true },
      { kind: 'mouse_button', button: 1, x: 10, y: 20, pressed: false },
      { kind: 'mouse_motion', x: 30, y: 40 },
    ])
      assert.notEqual((await call('simulate_input', event)).isError, true);
    let logs;
    const deadline = Date.now() + 3000;
    do {
      logs = JSON.parse((await call('get_debug_output')).content[0].text);
      if (logs.output.some((line) => line.startsWith('motion event 30'))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.ok(logs.output.includes('key event 32'), JSON.stringify(logs));
    assert.ok(logs.output.includes('mouse event 1'), JSON.stringify(logs));
    assert.ok(
      logs.output.some((line) => line.startsWith('motion event 30')),
      JSON.stringify(logs),
    );
    assert.ok(logs.output.includes('received action'), JSON.stringify(logs));
    assert.notEqual((await call('set_debug_pause', { paused: true })).isError, true);
    const tree = await call('get_runtime_tree', { maxDepth: 0, maxNodes: 1 });
    assert.notEqual(tree.isError, true, JSON.stringify(tree));
    const treeData = JSON.parse(tree.content[0].text);
    assert.equal(treeData.nodes[0].path, '.');
    assert.equal(treeData.nodes[0].scriptPath, 'res://scene.gd');
    assert.equal(treeData.paused, true);
    assert.equal((await call('get_runtime_tree', { maxNodes: 0 })).isError, true);
    const capture = await call('capture_screenshot');
    if (render) {
      assert.equal(capture.content[0].type, 'image', JSON.stringify(capture));
      assert.notEqual(capture.content[0].data, before.content[0].data);
      assert.equal(JSON.parse(capture.content[1].text).paused, true);
    } else assert.equal(capture.isError, true);
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), project);
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), scene);
    await call('stop_project');
    assert.equal((await call('capture_screenshot')).isError, true);
    assert.equal(JSON.parse((await call('get_debug_output')).content[0].text).running, false);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
