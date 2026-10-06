import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setMainScene } from '../build/authoring-tools.js';
import { handleConfigurationTool, validateBindings } from '../build/configuration-tools.js';
import {
  parseProjectConfig,
  patchProjectConfig,
  saveProjectConfig,
  withProjectConfig,
} from '../build/project-config.js';

const godot = process.env.GODOT_TEST_PATH;
const data = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};

test('configuration patches preserve CRLF, strings, multiline values and unrelated comments; ambiguous syntax is refused', () => {
  const text =
    '; header\r\nconfig_version=5\r\n\r\n[application]\r\nconfig/name="Game ; [input] \\"quoted\\"" ; name\r\nrun/main_scene="res://old.tscn" ; scene\r\n\r\n[input]\r\njump={\r\n"deadzone": 0.5, ; comment inside\r\n"events": [Object(InputEventKey,"keycode":32)]\r\n}\r\n\r\n[custom]\r\nvalue={"line": "[application]", "array": [1, 2]}\r\n';
  assert.equal(parseProjectConfig(text).entries.length, 5);
  const edited = patchProjectConfig(text, 'application', 'run/main_scene', '"res://new.tscn"');
  assert.equal(edited, text.replace('"res://old.tscn"', '"res://new.tscn"'));
  const replacement = '{\n"deadzone": 0.2,\n"events": []\n}';
  const rebound = patchProjectConfig(text, 'input', 'jump', replacement);
  assert.ok(rebound.includes(replacement.replaceAll('\n', '\r\n')));
  assert.ok(rebound.includes('[custom]\r\nvalue={"line": "[application]", "array": [1, 2]}\r\n'));
  assert.equal(parseProjectConfig(rebound).entries.length, 5);
  assert.ok(patchProjectConfig('[input]', 'input', 'walk', '{}').includes('[input]\nwalk={}\n'));
  const removed = patchProjectConfig(text, 'input', 'jump', null);
  assert.ok(!removed.includes('jump='));
  assert.ok(removed.includes('[custom]'));
  for (const bad of [
    '[input]\njump={}\n[input]\nother={}\n',
    '[input]\nx=1\nx=2\n',
    '[input]\nx={\n',
    '[input]\nx="unfinished',
    '[input]\nx=[}\n',
  ])
    assert.throws(() => parseProjectConfig(bad));
});

test('project.godot writers share a queue, reject concurrent changes/cancellation, and validate bindings before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-config-atomic-'));
  try {
    const file = join(root, 'project.godot');
    await writeFile(file, 'config_version=5\n[application]\nconfig/name="Game"\n');
    await Promise.all([
      setMainScene(root, 'res://main.tscn'),
      withProjectConfig(root, async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await saveProjectConfig(
          snapshot,
          patchProjectConfig(snapshot.original, 'application', 'config/name', '"Updated"'),
          false,
        );
      }),
    ]);
    const saved = await readFile(file, 'utf8');
    assert.ok(saved.includes('run/main_scene="res://main.tscn"'));
    assert.ok(saved.includes('config/name="Updated"'));
    for (const kind of ['external', 'cancel'])
      await withProjectConfig(root, async (snapshot) => {
        const controller = new AbortController();
        if (kind === 'external') await writeFile(file, 'config_version=5\n; external\n');
        else controller.abort();
        await assert.rejects(saveProjectConfig(snapshot, 'replacement', false, controller.signal));
        assert.notEqual(await readFile(file, 'utf8'), 'replacement');
      });
    const notRun = { run: () => assert.fail('Invalid bindings must not execute Godot') };
    for (const events of [
      null,
      [{ kind: 'key', key: 'A', keycode: 65 }],
      [{ kind: 'mouse_button', button: 0 }],
      [{ kind: 'joypad_motion', axis: 0, axisValue: 0.5 }],
      [{ kind: 'key', key: 'A', arbitrary: true }],
    ]) {
      assert.throws(() => validateBindings(events));
      await assert.rejects(
        handleConfigurationTool(
          'set_input_action',
          { projectPath: root, action: 'jump', events },
          'fake',
          'scripts',
          notRun,
        ),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real Godot configuration tools preserve comments, serialize bindings, guard previews and do not start autoloads', {
  skip: !godot,
  timeout: 120000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-configuration-'));
  const client = new Client({ name: 'configuration-regression', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  try {
    const untouched =
      '; untouched tail\r\n[custom]\r\nvalue={\r\n"text": "[input] ; literal",\r\n"array": [1, 2, 3]\r\n}\r\n';
    const original =
      '; Header\r\nconfig_version=5\r\n[application]\r\nconfig/name="Game" ; retain name comment\r\nrun/main_scene="res://scene.tscn"\r\n[display]\r\nwindow/size/viewport_width = 800 ; width comment\r\n[autoload]\r\nExisting="*res://state.gd"\r\n' +
      untouched;
    await writeFile(join(root, 'project.godot'), original);
    await writeFile(
      join(root, 'state.gd'),
      'extends Node\nfunc _init():\n    var file = FileAccess.open("res://autoload-ran.txt", FileAccess.WRITE)\n    file.store_string("ran")\n',
    );
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene format=3]\n[node name="Root" type="Node2D"]\n',
    );
    await client.connect(transport);
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: { projectPath: root, ...args } });
    const read = data(
      await call('get_project_setting', { setting: 'display/window/size/viewport_width' }),
    );
    assert.equal(read.expression, '800');
    assert.equal(
      data(await call('get_project_setting', { setting: 'custom/missing' })).stored,
      false,
    );
    const preview = data(
      await call('set_project_setting', {
        setting: 'display/window/size/viewport_width',
        value: 1280,
        dryRun: true,
      }),
    );
    assert.equal(preview.saved, false);
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), original);
    data(
      await call('set_project_setting', {
        setting: 'display/window/size/viewport_width',
        value: 1280,
        expectedHash: preview.sourceHash,
      }),
    );
    const updated = await readFile(join(root, 'project.godot'), 'utf8');
    assert.ok(updated.includes('window/size/viewport_width = 1280 ; width comment\r\n'));
    assert.ok(updated.includes(untouched));
    for (const args of [
      { setting: 'display/window/size/viewport_width', value: 'wrong' },
      { setting: 'input/jump', value: {} },
      { setting: 'custom/value', value: null },
      { setting: 'application/run/main_scene', value: '../escape.tscn' },
      {
        setting: 'display/window/size/viewport_width',
        value: 640,
        expectedHash: preview.sourceHash,
      },
    ]) {
      assert.equal((await call('set_project_setting', args)).isError, true);
      assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), updated);
    }
    data(
      await call('set_project_setting', {
        setting: 'game/vector',
        value: { type: 'Vector2', value: [3, 4] },
      }),
    );
    data(
      await call('set_project_setting', {
        setting: 'game/nested',
        value: { names: ['A', 'B'], literal_key: 'unchanged' },
      }),
    );
    data(await call('remove_project_setting', { setting: 'game/vector' }));
    assert.equal(data(await call('get_project_setting', { setting: 'game/vector' })).stored, false);
    data(
      await call('register_autoload', { name: 'State', resource_path: 'state.gd', dry_run: true }),
    );
    assert.equal(
      data(await call('get_project_setting', { setting: 'application/config/name' })).expression,
      '"Game"',
    );
    data(await call('register_autoload', { name: 'State', resourcePath: 'state.gd' }));
    assert.equal(
      data(await call('get_project_setting', { setting: 'autoload/State' })).expression,
      '"*res://state.gd"',
    );
    const ordered = await readFile(join(root, 'project.godot'), 'utf8');
    assert.ok(ordered.indexOf('Existing=') < ordered.indexOf('State='));
    assert.equal(
      (await call('register_autoload', { name: 'State', resourcePath: 'scene.tscn' })).isError,
      true,
    );
    data(
      await call('register_autoload', {
        name: 'State',
        resourcePath: 'scene.tscn',
        replace: true,
        singleton: false,
      }),
    );
    assert.equal(
      (await call('register_autoload', { name: 'Node', resourcePath: 'state.gd' })).isError,
      true,
    );
    assert.equal(
      (await call('register_autoload', { name: 'Missing', resourcePath: 'missing.gd' })).isError,
      true,
    );
    data(await call('unregister_autoload', { name: 'State' }));
    const events = [
      { kind: 'key', key: 'A', ctrl: true },
      { kind: 'key', key: 'C', command_or_control: true },
      { kind: 'key', physical_keycode: 68 },
      { kind: 'mouse_button', button: 1, shift: true },
      { kind: 'joypad_button', button: 0, device: 2 },
      { kind: 'joypad_motion', axis: 0, axis_value: -1 },
    ];
    const inputPreview = data(
      await call('set_input_action', { action: 'move_left', deadzone: 0.25, events, dryRun: true }),
    );
    assert.ok(
      !(await readFile(join(root, 'project.godot'), 'utf8').then((text) =>
        text.includes('move_left='),
      )),
    );
    data(
      await call('set_input_action', {
        action: 'move_left',
        deadzone: 0.25,
        events,
        expectedHash: inputPreview.sourceHash,
      }),
    );
    const actions = data(await call('get_input_actions', { action: 'move_left' }));
    assert.equal(actions.configuredOnly, true);
    assert.equal(actions.actions[0].deadzone, 0.25);
    assert.equal(actions.actions[0].events.length, 6);
    assert.equal(actions.actions[0].events[0].keycode, 65);
    assert.equal(actions.actions[0].events[1].commandOrControl, true);
    assert.equal(actions.actions[0].events[2].physicalKeycode, 68);
    data(
      await call('set_input_action', { action: 'move_left', events: actions.actions[0].events }),
    );
    data(await call('set_input_action', { action: 'move_left', events: [] }));
    const cleared = data(await call('get_input_actions', { action: 'move_left' }));
    assert.equal(cleared.actions[0].deadzone, 0.25);
    assert.deepEqual(cleared.actions[0].events, []);
    data(await call('remove_input_action', { action: 'move_left' }));
    assert.deepEqual(data(await call('get_input_actions')).actions, []);
    assert.equal(
      (
        await call('set_input_action', {
          action: 'jump',
          events: [{ kind: 'key', key: 'NotARealKey' }],
        })
      ).isError,
      true,
    );
    await assert.rejects(readFile(join(root, 'autoload-ran.txt')), /ENOENT/);
    assert.ok((await readFile(join(root, 'project.godot'), 'utf8')).includes(untouched));
    // Fresh runtime observes the saved config and starts the existing autoload normally.
    data(
      await call('set_input_action', { action: 'jump', events: [{ kind: 'key', key: 'Space' }] }),
    );
    data(await call('start_debug_session', { headless: true }));
    data(await call('simulate_input', { kind: 'action', action: 'jump', pressed: true }));
    data(await call('stop_project'));
    assert.equal(await readFile(join(root, 'autoload-ran.txt'), 'utf8'), 'ran');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
