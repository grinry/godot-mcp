import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleExtraTool } from '../build/workflow-tools.js';

const godot = process.env.GODOT_TEST_PATH;
test('real export: Web preset produces artifacts and missing preset fails', {
  skip: !godot || process.env.GODOT_TEST_EXPORT !== 'true',
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'godot-export-test-'));
  try {
    await writeFile(
      join(root, 'project.godot'),
      'config_version=5\n[application]\nconfig/name="Export regression"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await writeFile(
      join(root, 'main.tscn'),
      '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n',
    );
    await writeFile(
      join(root, 'export_presets.cfg'),
      '[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="game.html"\n[preset.0.options]\nvariant/extensions_support=false\nvariant/thread_support=false\nvram_texture_compression/for_desktop=true\nhtml/export_icon=false\n',
    );
    const args = { projectPath: root, preset: 'Web', outputPath: 'game.html', timeoutMs: 30000 };
    const result = await handleExtraTool('export_project', args, godot, '');
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(await readFile(join(root, 'game.html'), 'utf8'), /html/i);
    assert.ok((await stat(join(root, 'game.wasm'))).size > 1000);
    const missing = await handleExtraTool(
      'export_project',
      { ...args, preset: 'Missing' },
      godot,
      '',
    );
    assert.equal(missing.isError, true, JSON.stringify(missing));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
