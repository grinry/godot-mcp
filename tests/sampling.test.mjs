import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  handleSamplingTool,
  numericSummary,
  samplingParameters,
  summarizeSeries,
} from '../build/sampling-tools.js';

const godot = process.env.GODOT_TEST_PATH;
const data = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};

test('sampling validates frame budgets/fields and computes nearest-rank scalar/vector summaries', async () => {
  const summary = numericSummary([3, 1, 2, 10]);
  assert.equal(summary.mean, 4);
  assert.equal(summary.p50, 2);
  assert.equal(summary.p95, 10);
  assert.equal(summary.delta, 7);
  const overflow = numericSummary([-Number.MAX_VALUE, Number.MAX_VALUE]);
  assert.equal(overflow.delta, null);
  assert.equal(overflow.arithmeticOverflow, true);
  assert.equal(
    summarizeSeries([
      { type: 'Vector2', value: [1, 2] },
      { type: 'Vector2', value: [3, 6] },
    ]).components.y.delta,
    4,
  );
  assert.deepEqual(summarizeSeries([null, null]), { kind: 'unavailable', count: 0 });
  assert.equal(summarizeSeries([true, true, false]).changes, 1);
  for (const args of [
    { samples: 0 },
    { samples: 120, intervalFrames: 120 },
    { monitors: ['missing'] },
    { monitors: ['fps', 'fps'] },
    { kind: 'invalid' },
  ])
    assert.throws(() => samplingParameters('sample_performance', args));
  assert.throws(() =>
    samplingParameters('sample_node_properties', {
      nodePath: '../outside',
      properties: ['counter'],
    }),
  );
  let observedTimeout;
  const session = {
    live: {
      request: async (_operation, _params, _signal, timeout) => {
        observedTimeout = timeout;
        return { samples: [{ values: { fps: 10 } }, { values: { fps: 20 } }] };
      },
    },
  };
  const result = await handleSamplingTool(
    'sample_performance',
    { samples: 2, monitors: ['fps'], timeoutMs: 12000 },
    session,
  );
  assert.equal(observedTimeout, 12000);
  assert.equal(result.structuredContent.summaries.fps.mean, 15);
});

test('real sampled properties advance exact physics callbacks, retain pause, bound evidence and cancel owned IPC', {
  skip: !godot,
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-sampling-'));
  const client = new Client({ name: 'sampling-regression', version: '1' });
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
      join(root, 'scene.gd'),
      'extends Node2D\nvar counter = 0\nvar large = "x".repeat(5000)\nfunc _physics_process(_delta):\n    counter += 1\n    position.x += 2\n',
    );
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Root" type="Node2D"]\nscript = ExtResource("1")\n',
    );
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    data(await call('start_debug_session', { projectPath: root, headless: true }));
    assert.equal((await call('sample_performance', { samples: 2 })).isError, true);
    data(await call('set_debug_pause', { paused: true }));
    const before = data(
      await call('get_node_properties', { nodePath: '.', properties: ['counter'] }),
    ).properties.counter.value;
    const properties = data(
      await call('sample_node_properties', {
        node_path: '.',
        properties: ['counter', 'position'],
        samples: 5,
        interval_frames: 2,
      }),
    );
    assert.equal(properties.paused, true);
    assert.equal(properties.advancedFrames, 8);
    assert.deepEqual(
      properties.samples.map((sample) => sample.values.counter),
      [before, before + 2, before + 4, before + 6, before + 8],
    );
    assert.equal(properties.summaries.counter.mean, before + 4);
    assert.equal(properties.summaries.position.components.x.delta, 16);
    assert.ok(
      properties.samples.every(
        (sample) =>
          typeof sample.physicsFrame === 'number' && typeof sample.sampledAtMs === 'number',
      ),
    );
    const stable = data(
      await call('get_node_properties', { nodePath: '.', properties: ['counter'] }),
    ).properties.counter.value;
    assert.equal(
      (await call('sample_node_properties', { nodePath: '.', properties: ['missing'], samples: 2 }))
        .isError,
      true,
    );
    assert.equal(
      (await call('sample_node_properties', { nodePath: '.', properties: ['large'], samples: 2 }))
        .isError,
      true,
    );
    assert.equal(
      data(await call('get_node_properties', { nodePath: '.', properties: ['counter'] })).properties
        .counter.value,
      stable,
    );
    const performance = data(
      await call('sample_performance', {
        samples: 3,
        monitors: ['nodeCount', 'processTime', 'drawCalls'],
        intervalFrames: 1,
        kind: 'process',
      }),
    );
    assert.equal(performance.sampleCount, 3);
    assert.equal(performance.metrics.find((metric) => metric.name === 'processTime').unit, 'ms');
    assert.equal(performance.summaries.drawCalls.kind, 'unavailable');
    assert.equal(
      performance.metrics.find((metric) => metric.name === 'drawCalls').available,
      false,
    );
    assert.equal(data(await call('get_performance_monitors')).paused, true);
    const expired = await call('sample_performance', {
      samples: 120,
      intervalFrames: 10,
      timeoutMs: 10,
      monitors: ['fps'],
    });
    assert.equal(expired.isError, true);
    assert.equal(JSON.parse((await call('get_debug_output')).content[0].text).running, false);
    assert.equal((await call('get_performance_monitors')).isError, true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
