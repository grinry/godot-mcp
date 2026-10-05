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
test('shutdown escalates for a child ignoring SIGTERM', {
  skip: process.platform === 'win32',
}, async () => {
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

test('native argument arrays preserve spaces, quotes, unicode and JSON without shell interpretation', async () => {
  const args = [
    'project folder/scene.tscn',
    JSON.stringify({ name: 'Player "quoted"', position: [1, 2], text: 'Žaidimas $HOME `command`' }),
  ];
  const child = await GodotProcess.start(process.execPath, [fixture, 'argv', ...args]);
  await child.done;
  assert.equal(child.exitCode, 0);
  assert.deepEqual(JSON.parse(child.output[0]), args);
});

test('stopping a run terminates descendants in its owned process tree', async () => {
  const child = await GodotProcess.start(process.execPath, [fixture, 'nested']);
  try {
    for (let index = 0; index < 100 && !child.output.length; index++) await delay(10);
    const pid = Number(child.output[0]?.replace('child:', ''));
    assert.ok(pid > 0);
    await child.stop();
    for (let index = 0; index < 100; index++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
        return;
      }
      await delay(20);
    }
    assert.fail('Descendant survived process cleanup');
  } finally {
    await child.stop();
  }
});

test('cleanup escalates for descendants after root exit and with detached pipes', {
  skip: process.platform === 'win32',
}, async () => {
  for (const mode of ['orphan', 'nested-resistant']) {
    const child = await GodotProcess.start(process.execPath, [fixture, mode]);
    let pid;
    try {
      for (let index = 0; index < 100 && !child.output.length; index++) await delay(10);
      pid = Number(child.output[0]?.replace('child:', ''));
      assert.ok(pid > 0);
      if (mode === 'orphan') await child.done;
      process.kill(pid, 0);
      await child.stop();
      assert.equal(child.running, false);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await child.stop();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
});
