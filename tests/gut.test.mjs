import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { handleExtraTool } from '../build/workflow-tools.js';

const godot = process.env.GODOT_TEST_PATH;
const addon = process.env.GUT_TEST_ADDON_PATH;
test('real GUT runner: passing, failing and timed-out tests', {
  skip: !godot || !addon,
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-gut-test-'));
  try {
    await mkdir(join(root, 'addons'));
    await mkdir(join(root, 'tests'));
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[application]\nconfig/name="GUT regression"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await assert.rejects(
      handleExtraTool(
        'run_gut_tests',
        { projectPath: root, testFile: 'tests/test_case.gd' },
        godot,
        '',
      ),
      /Install GUT/,
    );
    await cp(addon, join(root, 'addons', 'gut'), { recursive: true });
    await writeFile(
      join(root, 'tests', 'test_case.gd'),
      'extends GutTest\nfunc test_passing():\n    assert_eq(1, 1)\n',
    );
    await promisify(execFile)(godot, ['--headless', '--path', root, '--editor', '--import'], {
      timeout: 20000,
    });
    const args = { projectPath: root, testFile: 'tests/test_case.gd', timeoutMs: 15000 };
    const passing = await handleExtraTool('run_gut_tests', args, godot, '');
    assert.equal(passing.isError, false, JSON.stringify(passing));
    await writeFile(
      join(root, 'tests', 'test_case.gd'),
      'extends GutTest\nfunc test_failing():\n    assert_eq(1, 2)\n',
    );
    const failing = await handleExtraTool('run_gut_tests', args, godot, '');
    assert.equal(failing.isError, true, JSON.stringify(failing));
    await writeFile(
      join(root, 'tests', 'test_case.gd'),
      'extends GutTest\nfunc helper_only():\n    pass\n',
    );
    const empty = await handleExtraTool('run_gut_tests', args, godot, '');
    assert.equal(empty.isError, true, JSON.stringify(empty));
    await writeFile(
      join(root, 'tests', 'test_case.gd'),
      'extends GutTest\nfunc test_timeout():\n    await get_tree().create_timer(30).timeout\n',
    );
    const timed = await handleExtraTool('run_gut_tests', { ...args, timeoutMs: 500 }, godot, '');
    assert.equal(JSON.parse(timed.content[0].text).timedOut, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
