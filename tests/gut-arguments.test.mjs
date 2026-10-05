import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gutArguments } from '../build/workflow-tools.js';

test('GUT argument builder checks addon, containment, selection and booleans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-gut-args-'));
  try {
    await mkdir(join(root, 'addons', 'gut'), { recursive: true });
    await mkdir(join(root, 'test dir'));
    await writeFile(join(root, 'addons', 'gut', 'gut_cmdln.gd'), '');
    await writeFile(join(root, 'test dir', 'test_case.gd'), '');
    const args = await gutArguments(root, { testFile: 'res://test dir/test_case.gd' });
    assert.ok(args.includes('-gtest=res://test dir/test_case.gd'));
    assert.ok(args.includes('-gexit'));
    assert.ok(args.includes('--headless'));
    assert.ok(
      (await gutArguments(root, { directory: 'test dir', headless: false })).includes(
        '-gdir=res://test dir',
      ),
    );
    assert.ok(
      !(await gutArguments(root, { directory: 'test dir', headless: false })).includes(
        '--headless',
      ),
    );
    for (const invalid of [
      {},
      { testFile: 'test dir/test_case.gd', directory: 'test dir' },
      { directory: '../' },
      { directory: 'test dir', headless: 'false' },
      { directory: 'test dir', logLevel: NaN },
    ])
      await assert.rejects(gutArguments(root, invalid));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
