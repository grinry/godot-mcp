import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listProjectFiles } from '../build/project-files.js';
import { projectFile, projectRoot } from '../build/project-paths.js';

test('discovery filters, caps results, skips symlinks and detects escaping paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-discovery-'));
  const outside = await mkdtemp(join(tmpdir(), 'godot-discovery-outside-'));
  try {
    await mkdir(join(root, 'scenes'));
    await mkdir(join(root, '.godot'));
    for (const file of [
      'project.godot',
      'scenes/a.tscn',
      'main.gd',
      'include.gdshaderinc',
      '.godot/hidden.gd',
    ])
      await writeFile(join(root, file), '');
    await symlink(
      join(root, 'scenes'),
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const all = await listProjectFiles(root);
    assert.equal(all.total, 3);
    assert.deepEqual(all.resources, ['include.gdshaderinc']);
    assert.deepEqual((await listProjectFiles(root, { pattern: '**/*.tscn' })).scenes, [
      'scenes/a.tscn',
    ]);
    assert.equal((await listProjectFiles(root, { limit: 1 })).truncated, true);
    await assert.rejects(listProjectFiles(root, { pattern: '../*' }));
    await assert.rejects(listProjectFiles(root, { type: 'bad' }));
    await assert.rejects(listProjectFiles(root, { limit: NaN }));
    assert.equal(await projectRoot(root), await realpath(root));
    assert.match(
      (await projectFile(await projectRoot(root), 'res://scenes/a.tscn')).resource,
      /^res:\/\//,
    );
    await assert.rejects(projectFile(root, 'scenes/../main.gd'));
    await writeFile(join(outside, 'outside.gd'), '');
    await symlink(
      outside,
      join(root, 'outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(projectFile(root, 'outside/outside.gd'), /escapes/);
    const aborted = AbortSignal.abort();
    await assert.rejects(listProjectFiles(root, { signal: aborted }));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
