import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { OperationRunner } from '../build/operation-runner.js';
import { runPlaytest, validatePlaytest } from '../build/playtest-tools.js';
import { pngDimensions, ScreenshotComparison } from '../build/screenshot-comparison.js';

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function png(width, height, pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([header, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y++)
    rows.push(Buffer.from([0]), pixels.subarray(y * width * 4, (y + 1) * width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const visual = {
  op: 'compare_screenshot',
  baselinePath: 'baseline.png',
  pixelTolerance: 0,
  maxChangedRatio: 0,
};
const scripts = resolve('build/scripts');
const godot = process.env.GODOT_TEST_PATH;

test('visual scenarios validate tolerances, assertion budgets and PNG allocation limits', () => {
  assert.equal(validatePlaytest({ headless: false, steps: [visual] }).steps[0].pixelTolerance, 0);
  for (const step of [
    { ...visual, pixelTolerance: -1 },
    { ...visual, pixelTolerance: 256 },
    { ...visual, pixelTolerance: 0.1 },
    { ...visual, maxChangedRatio: 1.1 },
    { ...visual, maxChangedRatio: Number.NaN },
    { ...visual, baselinePath: '' },
  ])
    assert.throws(() => validatePlaytest({ headless: false, steps: [step] }));
  assert.throws(() => validatePlaytest({ steps: [visual] }), /headless/);
  assert.throws(() => validatePlaytest({ headless: false, steps: Array(4).fill(visual) }), /three/);
  const state = { op: 'assert', nodePath: '.', property: 'name', expected: 'Root' };
  assert.throws(
    () => validatePlaytest({ headless: false, steps: [...Array(50).fill(state), visual] }),
    /50/,
  );
  assert.throws(() => pngDimensions(Buffer.from('not png')), /PNG/);
  const valid = png(2, 2, Buffer.alloc(16, 255));
  assert.deepEqual(pngDimensions(valid), { width: 2, height: 2 });
  const large = Buffer.from(valid);
  large.writeUInt32BE(4097, 16);
  assert.throws(() => pngDimensions(large), /dimensions/);
  assert.throws(() => pngDimensions(Buffer.alloc(8 * 1024 * 1024 + 1)), /8 MiB/);
});

test('baseline preflight rejects missing, escaping and malformed PNGs without replacing the game', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-baseline-invalid-'));
  const runner = new OperationRunner();
  const outside = `${root}-outside.png`;
  let launched = false;
  let closed = false;
  const session = {
    live: {
      start: async () => {
        launched = true;
      },
      close: async () => {
        closed = true;
      },
    },
    game: { current: { running: true } },
  };
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    await writeFile(join(root, 'bad.png'), 'not png');
    for (const baselinePath of ['missing.png', '../escape.png', 'bad.png']) {
      const result = await runPlaytest(
        { projectPath: root, headless: false, steps: [{ ...visual, baselinePath }] },
        session,
        'unused',
        scripts,
        undefined,
        runner,
      );
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.stopped, false);
      assert.equal(launched, false);
      assert.equal(closed, false);
    }
    if (process.platform !== 'win32') {
      await writeFile(outside, png(1, 1, Buffer.alloc(4, 255)));
      await symlink(outside, join(root, 'escape.png'));
      await assert.rejects(
        ScreenshotComparison.prepare(
          [{ ...visual, baselinePath: 'escape.png' }],
          root,
          'unused',
          scripts,
          runner,
        ),
        /escapes/,
      );
    }
  } finally {
    await runner.close();
    await rm(outside, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('real Godot visual comparison counts RGBA differences, respects inclusive tolerances and snapshots baselines', {
  skip: !godot,
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-baseline-'));
  const runner = new OperationRunner();
  let comparison;
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[autoload]\nTrap="*res://trap.gd"\n',
    );
    await writeFile(
      join(root, 'trap.gd'),
      'extends Node\nfunc _init():\n    FileAccess.open("res://ran.txt",FileAccess.WRITE).store_string("ran")\n',
    );
    const baseline = png(2, 2, Buffer.alloc(16, 255));
    await writeFile(join(root, 'baseline.png'), baseline);
    comparison = await ScreenshotComparison.prepare([visual], root, godot, scripts, runner);
    await writeFile(join(root, 'baseline.png'), 'externally changed after snapshot');
    const exact = await comparison.compare(visual, baseline.toString('base64'));
    assert.equal(exact.result.passed, true);
    assert.equal(exact.result.changedPixels, 0);
    assert.deepEqual(pngDimensions(Buffer.from(exact.diff, 'base64')), { width: 2, height: 2 });
    const pixels = Buffer.alloc(16, 255);
    pixels[0] = 245;
    pixels[7] = 235; // Alpha-only difference in the second pixel.
    const changed = png(2, 2, pixels).toString('base64');
    const failed = await comparison.compare(visual, changed);
    assert.equal(failed.result.passed, false);
    assert.equal(failed.result.changedPixels, 2);
    assert.equal(failed.result.changedPercentage, 50);
    assert.equal(failed.result.maxChannelDelta, 20);
    const tolerance = await comparison.compare(
      { ...visual, pixelTolerance: 10, maxChangedRatio: 0.25 },
      changed,
    );
    assert.equal(tolerance.result.passed, true);
    assert.equal(tolerance.result.changedPixels, 1);
    assert.equal(
      (await comparison.compare({ ...visual, pixelTolerance: 20 }, changed)).result.changedPixels,
      0,
    );
    const mismatched = await comparison.compare(
      visual,
      png(1, 1, Buffer.alloc(4, 255)).toString('base64'),
    );
    assert.equal(mismatched.result.code, 'IMAGE_DIMENSION_MISMATCH');
    assert.equal(mismatched.diff, undefined);
    assert.equal(
      await readFile(join(root, 'baseline.png'), 'utf8'),
      'externally changed after snapshot',
    );
    await assert.rejects(readFile(join(root, 'ran.txt')), /ENOENT/);
    const corrupt = Buffer.from(baseline);
    corrupt.fill(0, 33);
    await writeFile(join(root, 'corrupt.png'), corrupt);
    await assert.rejects(
      ScreenshotComparison.prepare(
        [{ ...visual, baselinePath: 'corrupt.png' }],
        root,
        godot,
        scripts,
        runner,
      ),
      /parse|PNG|image/i,
    );
  } finally {
    await comparison?.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('visual comparison deadline/cancellation stops the owned game and removes baseline snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-visual-cancel-'));
  try {
    await writeFile(join(root, 'project.godot'), 'config_version=5\n');
    const image = png(1, 1, Buffer.alloc(4, 255));
    await writeFile(join(root, 'baseline.png'), image);
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let temporary;
      let stopped = false;
      const session = {
        game: { current: { running: true, snapshot: () => ({ output: [], errors: [] }) } },
        live: {
          start: async () => {},
          request: async (operation) =>
            operation === 'screenshot' ? { image: image.toString('base64') } : {},
          close: async () => {
            stopped = true;
            session.game.current.running = false;
          },
        },
      };
      const runner = {
        run: async (_godot, args, _timeout, signal) => {
          temporary = args[2];
          if (args[6] === 'compare') {
            if (cancel) controller.abort();
            else await new Promise((resolve) => setTimeout(resolve, 100));
            signal.throwIfAborted();
          }
          return {
            output: ['GODOT_MCP_RESULT {"validated":true}'],
            errors: [],
            exitCode: 0,
            timedOut: false,
            truncated: false,
          };
        },
      };
      const pending = runPlaytest(
        { projectPath: root, headless: false, timeoutMs: 50, steps: [visual] },
        session,
        'mock',
        scripts,
        controller.signal,
        runner,
      );
      if (cancel) await assert.rejects(pending, /abort/i);
      else {
        const result = await pending;
        assert.equal(result.structuredContent.code, 'TIMEOUT');
        assert.equal(result.structuredContent.stopped, true);
      }
      assert.equal(stopped, true);
      await assert.rejects(readFile(join(temporary, 'baseline-0.png')), /ENOENT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
