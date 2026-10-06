import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compareState, runPlaytest, validatePlaytest } from '../build/playtest-tools.js';

const godot = process.env.GODOT_TEST_PATH;
const assertion = { op: 'assert', nodePath: '.', property: 'counter', expected: 5 };
const data = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};

test('playtests reject incomplete/oversized scenarios and never assert partial values as equal', () => {
  for (const steps of [
    [],
    [{ op: 'input', event: { kind: 'action', action: 'ui_accept' } }, assertion],
    [{ ...assertion, nodePath: '../outside' }],
    [{ ...assertion, comparison: 'unknown' }],
    [{ ...assertion, tolerance: -1 }],
    [{ ...assertion, expected: Number.NaN }],
    [{ ...assertion, property: '' }],
    [{ ...assertion, comparison: 'gt', expected: '5' }],
    [{ op: 'frames', frames: 121 }, assertion],
    [{ op: 'frames', frames: 1 }],
    [assertion, { op: 'input', event: { kind: 'action', action: 'ui_accept' } }],
    [{ op: 'screenshot' }, assertion],
  ])
    assert.throws(() => validatePlaytest({ steps }));
  assert.equal(validatePlaytest({ steps: [assertion] }).timeoutMs, 60000);
  assert.equal(
    compareState(
      { type: 'Vector2', value: [1, 2] },
      { type: 'Vector2', value: [1.001, 2.001] },
      'approx',
      0.002,
    ),
    true,
  );
  assert.equal(compareState(5, 4, 'gte', 0), true);
  assert.equal(compareState(false, 0, 'eq', 0), false);
  assert.equal(
    compareState(
      { type: 'NodePath', value: 'Child', truncated: false },
      { type: 'NodePath', value: 'Child' },
      'eq',
      0,
    ),
    true,
  );
  assert.throws(
    () =>
      compareState(
        { type: 'Array', value: [], truncated: true },
        { type: 'Array', value: [] },
        'eq',
        0,
      ),
    /truncated/,
  );
});

test('playtest failures, cancellation and deadlines clean up the owned game; invalid input preserves existing sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-playtest-cleanup-'));
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    for (const kind of ['failure', 'cancel', 'timeout', 'invalid', 'loglimit']) {
      const controller = new AbortController();
      let closed = false;
      let launched = false;
      const session = {
        game: {
          current: {
            running: true,
            snapshot: () => ({ output: [], errors: [], truncated: kind === 'loglimit' }),
          },
        },
        live: {
          start: async () => {
            launched = true;
          },
          request: async (_operation, _params, signal) => {
            if (kind === 'cancel') controller.abort();
            if (kind === 'timeout') await new Promise((resolve) => setTimeout(resolve, 30));
            signal.throwIfAborted();
            if (kind === 'loglimit')
              return _operation === 'properties' ? { properties: { counter: { value: 5 } } } : {};
            throw new Error('Missing node');
          },
          close: async () => {
            closed = true;
            session.game.current.running = false;
          },
        },
      };
      const args = {
        projectPath: root,
        timeoutMs: kind === 'timeout' ? 10 : 1000,
        steps: kind === 'invalid' ? [{ op: 'invalid' }] : [assertion],
      };
      if (kind === 'invalid' || kind === 'cancel')
        await assert.rejects(runPlaytest(args, session, 'fake', 'scripts', controller.signal));
      else {
        const result = await runPlaytest(args, session, 'fake', 'scripts', controller.signal);
        assert.equal(result.structuredContent.passed, false);
        assert.equal(
          result.structuredContent.code,
          kind === 'timeout' ? 'TIMEOUT' : kind === 'loglimit' ? 'OUTPUT_LIMIT' : 'RUNTIME_ERROR',
        );
      }
      assert.equal(closed, kind !== 'invalid');
      assert.equal(launched, kind !== 'invalid');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frame-based gameplay assertions, queued input, monitor snapshots and scenario cleanup work through MCP', {
  skip: !godot,
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-playtest-'));
  const client = new Client({ name: 'playtest-regression', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot },
    stderr: 'ignore',
  });
  try {
    const project = 'config_version=5\n[application]\nrun/main_scene="res://scene.tscn"\n';
    const script =
      'extends Node2D\nvar counter = 0\nvar key_events = 0\nfunc _physics_process(_delta):\n    if Input.is_action_pressed("ui_accept"):\n        counter += 1\n        position.x += 2\nfunc _input(event):\n    if event is InputEventKey and event.pressed:\n        key_events += 1\n';
    const scene =
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Root" type="Node2D"]\nscript = ExtResource("1")\n';
    await writeFile(join(root, 'project.godot'), project);
    await writeFile(join(root, 'scene.gd'), script);
    await writeFile(join(root, 'scene.tscn'), scene);
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    data(await call('start_debug_session', { projectPath: root, headless: true }));
    data(await call('set_debug_pause', { paused: true }));
    const monitor = data(await call('get_performance_monitors'));
    assert.equal(monitor.paused, true);
    assert.equal(typeof monitor.sampledAtMs, 'number');
    assert.equal(monitor.monitors.find((item) => item.name === 'processTime').unit, 'ms');
    assert.ok(monitor.monitors.find((item) => item.name === 'nodeCount').value >= 2);
    assert.deepEqual(
      monitor.monitors.find((item) => item.name === 'drawCalls'),
      { name: 'drawCalls', value: null, unit: 'count', available: false },
    );
    const steps = [
      { ...assertion, expected: 0 },
      { op: 'input', event: { kind: 'action', action: 'ui_accept', pressed: true } },
      { op: 'input', event: { kind: 'key', keycode: 65, pressed: true } },
      { op: 'frames', frames: 5 },
      assertion,
      { op: 'assert', node_path: '.', property: 'key_events', expected: 1 },
      { op: 'input', event: { kind: 'action', action: 'ui_accept', pressed: false } },
      { op: 'input', event: { kind: 'key', keycode: 65, pressed: false } },
      { op: 'frames', frames: 2 },
      assertion,
      {
        op: 'assert',
        nodePath: '.',
        property: 'position',
        expected: { type: 'Vector2', value: [10, 0] },
        comparison: 'approx',
        tolerance: 0.0001,
      },
    ];
    const played = data(await call('run_playtest', { project_path: root, steps }));
    assert.equal(played.passed, true);
    assert.equal(played.stopped, true);
    assert.equal(played.completedSteps, steps.length);
    assert.equal(JSON.parse((await call('get_debug_output')).content[0].text).running, false);
    const failed = await call('run_playtest', {
      projectPath: root,
      steps: [{ ...assertion, expected: 999 }],
    });
    assert.equal(failed.isError, true);
    const failure = JSON.parse(failed.content[0].text);
    assert.equal(failure.steps[0].actual, 0);
    assert.equal(failure.steps[0].passed, false);
    assert.equal(failure.stopped, true);
    const unavailable = await call('run_playtest', {
      projectPath: root,
      steps: [{ ...assertion, property: 'missing' }],
    });
    assert.equal(JSON.parse(unavailable.content[0].text).code, 'RUNTIME_ERROR');
    assert.equal((await call('get_performance_monitors')).isError, true);
    if (process.env.GODOT_TEST_RENDER === 'true') {
      const captured = await call('run_playtest', {
        projectPath: root,
        headless: false,
        steps: [
          { op: 'frames', frames: 2, kind: 'process' },
          { op: 'screenshot' },
          { ...assertion, expected: 0 },
        ],
      });
      const result = data(captured);
      assert.equal(result.screenshotCount, 1);
      assert.equal(captured.content[1].type, 'image');
      assert.equal(captured.content[1].mimeType, 'image/png');
      const baseline = Buffer.from(captured.content[1].data, 'base64');
      await writeFile(join(root, 'baseline.png'), baseline);
      const compared = await call('run_playtest', {
        projectPath: root,
        headless: false,
        steps: [
          { op: 'frames', frames: 2, kind: 'process' },
          { op: 'compare_screenshot', baseline_path: 'baseline.png' },
        ],
      });
      const comparison = data(compared);
      assert.equal(comparison.steps[1].changedPixels, 0);
      assert.equal(comparison.screenshotCount, 1);
      assert.equal(comparison.diffCount, 1);
      assert.equal(compared.content[comparison.steps[1].diffImageIndex + 1].type, 'image');
      assert.equal(comparison.stopped, true);
      assert.deepEqual(await readFile(join(root, 'baseline.png')), baseline);
      await call('start_debug_session', { projectPath: root, headless: true });
      const invalid = await call('run_playtest', {
        projectPath: root,
        headless: false,
        steps: [{ op: 'compare_screenshot', baselinePath: 'missing.png' }],
      });
      assert.equal(invalid.isError, true);
      assert.equal(JSON.parse((await call('get_debug_output')).content[0].text).running, true);
      await call('stop_project');
    }
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), project);
    assert.equal(await readFile(join(root, 'scene.tscn'), 'utf8'), scene);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
