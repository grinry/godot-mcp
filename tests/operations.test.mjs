import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { observeEditorStartup } from '../build/editor-startup.js';
import { GodotProcess } from '../build/godot-process.js';
import { OperationRunner } from '../build/operation-runner.js';
import { projectOutput } from '../build/project-paths.js';
import { ToolPolicy } from '../build/tool-policy.js';

const fixture = fileURLToPath(new URL('./fixtures/process.mjs', import.meta.url));
test('one-shot cancellation and shutdown terminate tracked children including pending starts', async () => {
  const runner = new OperationRunner();
  const abort = new AbortController();
  const pending = runner.run(process.execPath, [fixture], 10000, abort.signal);
  const rejected = assert.rejects(pending, /abort/i);
  await delay(40);
  abort.abort();
  await rejected;
  const shutdown = runner.run(process.execPath, [fixture], 10000);
  const stopped = assert.rejects(shutdown, /shutting down/);
  await runner.close();
  await stopped;
  await assert.rejects(runner.run(process.execPath, [fixture]), /shutting down/);
});
test('editor launch reports early diagnostics and exits, while retaining logs', async () => {
  for (const args of [
    [
      '--input-type=module',
      '-e',
      'console.error("ERROR: missing project resource");setInterval(()=>{},1000)',
    ],
    ['-e', 'process.exit(7)'],
  ]) {
    const child = await GodotProcess.start(process.execPath, args);
    await assert.rejects(
      observeEditorStartup(child, undefined, 150),
      /missing project resource|exitCode/,
    );
    assert.equal(child.running, false);
  }
});
test('policy enforces canonical roots and read-only tools without allowing symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-policy-'));
  const outside = await mkdtemp(join(tmpdir(), 'godot-policy-outside-'));
  try {
    await mkdir(join(root, 'inside'));
    await writeFile(join(root, 'inside', 'project.godot'), 'config_version=5\n');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const policy = new ToolPolicy([root], true);
    await policy.check('get_project_info', { projectPath: join(root, 'inside') });
    await assert.rejects(
      policy.check('get_project_info', { projectPath: join(root, 'escape') }),
      /outside/,
    );
    await assert.rejects(policy.check('run_scene', { projectPath: root }), /READ_ONLY/);
    await assert.rejects(policy.check('attach_script', { projectPath: root }), /READ_ONLY/);
    await assert.rejects(projectOutput(root, 'escape/scene.tscn'), /escapes/);
    await assert.rejects(projectOutput(root, '../scene.tscn'), /inside/);
    assert.equal((await projectOutput(root, 'new/scene.tscn')).resource, 'res://new/scene.tscn');
    await policy.check('get_class_info', { className: 'Node' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('output confinement rejects dangling file and directory symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-output-'));
  const outside = await mkdtemp(join(tmpdir(), 'godot-output-outside-'));
  try {
    await symlink(join(outside, 'missing.tscn'), join(root, 'scene.tscn'), 'file');
    await assert.rejects(projectOutput(root, 'scene.tscn'), /Dangling output symlink/);
    await symlink(
      join(outside, 'missing'),
      join(root, 'folder'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(projectOutput(root, 'folder/scene.tscn'), /Dangling output symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('session closure rejects pending launches and permanently closes process slots', async () => {
  const { GodotSession } = await import('../build/godot-session.js');
  const session = new GodotSession();
  let resume;
  let entered;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const launch = session.run(async () => {
    entered();
    await gate;
    return session.game.start(process.execPath, [fixture]);
  });
  const rejected = assert.rejects(launch, /closed/);
  await ready;
  const queued = assert.rejects(
    session.run(() => session.editor.start(process.execPath, [fixture])),
    /closed/,
  );
  const closing = session.close();
  resume();
  await Promise.all([closing, rejected, queued]);
  assert.equal(session.game.current, null);
  assert.equal(session.editor.current, null);
  await assert.rejects(
    session.run(async () => 'reopen'),
    /closed/,
  );
  await assert.rejects(session.game.start(process.execPath, [fixture]), /closed/);
});
