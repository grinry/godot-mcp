import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GodotProcess, ProcessSlot } from '../build/godot-process.js';

const fixture = fileURLToPath(new URL('./fixtures/process.mjs', import.meta.url));
test('spawn failures reject without crashing', async () => {
  await assert.rejects(GodotProcess.start('/definitely/missing/godot', []), /ENOENT/);
});
test('logs join chunks and retain final unterminated lines', async () => {
  const child = await GodotProcess.start(process.execPath, [fixture, 'log']);
  await child.done;
  assert.deepEqual(child.output, ['split line', 'last']);
  assert.deepEqual(child.errors, ['error tail']);
  assert.equal(child.exitCode, 0);
});
test('output is capped for newline-free floods', async () => {
  const child = await GodotProcess.start(process.execPath, [fixture, 'flood']);
  await child.done;
  assert.equal(child.truncated, true);
  assert.equal(child.output.join('').length, 1024 * 1024);
});
test('shutdown escalates for a child ignoring SIGTERM', async () => {
  const child = await GodotProcess.start(process.execPath, [fixture, 'stubborn']);
  try {
    for (let index = 0; index < 100 && !child.output.includes('ready'); index++) await delay(10);
    assert.ok(child.output.includes('ready'));
    await child.stop();
    assert.equal(child.running, false);
    assert.equal(child.signal, 'SIGKILL');
  } finally {
    await child.stop();
  }
});
test('concurrent replacements leave one child and retain completed logs', async () => {
  const slot = new ProcessSlot();
  try {
    const children = await Promise.all([
      slot.start(process.execPath, [fixture]),
      slot.start(process.execPath, [fixture]),
    ]);
    assert.equal(children[0].running, false);
    assert.equal(children[1].running, true);
    await slot.stop();
    assert.equal(slot.current, children[1]);
    assert.equal(slot.current.running, false);
  } finally {
    await slot.stop();
  }
});
test('timeout closes a child and retains status', async () => {
  const child = await GodotProcess.start(process.execPath, [fixture], 30);
  await child.done;
  assert.equal(child.timedOut, true);
  assert.equal(child.running, false);
});
