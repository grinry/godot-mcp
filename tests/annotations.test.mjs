import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { changeAddon } from '../build/annotation-addon.js';
import { handleAnnotationTool } from '../build/annotation-tools.js';
import { ToolPolicy } from '../build/tool-policy.js';

const scripts = resolve('build/scripts');
const godot = process.env.GODOT_TEST_PATH;
const render = process.env.GODOT_TEST_RENDER === 'true';
const project =
  'config_version=5\n; retain this comment\n[application]\nconfig/name="MCP annotation tests"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'godot-annotations-'));
  await writeFile(join(root, 'project.godot'), project);
  return root;
}
async function editorDriver(root, code) {
  await mkdir(join(root, 'addons/test_driver'), { recursive: true });
  await writeFile(
    join(root, 'addons/test_driver/plugin.cfg'),
    '[plugin]\nname="Annotation test driver"\ndescription="Fixture"\nauthor="test"\nversion="1"\nscript="driver.gd"\n',
  );
  await writeFile(
    join(root, 'addons/test_driver/driver.gd'),
    `@tool\nextends EditorPlugin\nfunc _enter_tree():\n    call_deferred("check")\n${code}`,
  );
  const settings = await readFile(join(root, 'project.godot'), 'utf8');
  await writeFile(
    join(root, 'project.godot'),
    settings.replace(
      '"res://addons/godot_mcp_annotations/plugin.cfg")',
      '"res://addons/godot_mcp_annotations/plugin.cfg", "res://addons/test_driver/plugin.cfg")',
    ),
  );
}
const data = (result) => result.structuredContent;
const call = (root, name, args = {}) =>
  handleAnnotationTool(name, { projectPath: root, ...args }, scripts);

test('addon installation previews, preserves settings, refuses conflicts and removes only its files', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'project.godot'),
      `${project}\n[editor_plugins]\nenabled=PackedStringArray("res://addons/other/plugin.cfg") ; keep\n`,
    );
    const before = await readFile(join(root, 'project.godot'), 'utf8');
    const preview = await changeAddon(root, scripts, false, { dryRun: true });
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), before);
    await assert.rejects(
      changeAddon(root, scripts, false, { expectedHash: 'bad' }),
      /hash changed/,
    );
    await changeAddon(root, scripts, false, { expectedHash: preview.sourceHash });
    const installed = await readFile(join(root, 'project.godot'), 'utf8');
    assert.ok(
      installed.includes(
        '"res://addons/other/plugin.cfg", "res://addons/godot_mcp_annotations/plugin.cfg") ; keep',
      ),
    );
    assert.equal((await changeAddon(root, scripts, false, {})).changed, false);
    const file = join(root, 'addons/godot_mcp_annotations/panel.gd');
    const original = await readFile(file);
    await writeFile(file, 'user changes');
    await assert.rejects(changeAddon(root, scripts, false, {}), /modified/);
    await assert.rejects(changeAddon(root, scripts, true, {}), /modified/);
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), installed);
    await writeFile(file, original);
    await writeFile(join(root, 'addons/godot_mcp_annotations/panel.gd.uid'), 'uid://test');
    await mkdir(join(root, '.godot-mcp/annotations'), { recursive: true });
    await writeFile(join(root, '.godot-mcp/annotations/keep.txt'), 'annotation data');
    await changeAddon(root, scripts, true, {});
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), before);
    assert.equal(
      await readFile(join(root, '.godot-mcp/annotations/keep.txt'), 'utf8'),
      'annotation data',
    );
    assert.equal((await changeAddon(root, scripts, true, {})).changed, false);
    await mkdir(join(root, 'addons/godot_mcp_annotations'));
    await writeFile(join(root, 'addons/godot_mcp_annotations/plugin.cfg'), 'unowned');
    await assert.rejects(changeAddon(root, scripts, false, {}), /not owned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer rolls back staged files when settings change; policies and symlinks stay enforced', async () => {
  const root = await fixture();
  const outside = await fixture();
  try {
    await mkdir(join(root, 'addons'));
    await symlink(join(outside, 'addons'), join(root, 'addons/godot_mcp_annotations'));
    await assert.rejects(changeAddon(root, scripts, false, {}), /symlink/);
    await rm(join(root, 'addons/godot_mcp_annotations'));
    await assert.rejects(
      new ToolPolicy([], true).check('ensure_annotation_addon', { projectPath: root }),
      /blocks/,
    );
    await new ToolPolicy([], true).check('list_annotations', { projectPath: root });
    await assert.rejects(
      new ToolPolicy([root]).check('get_annotation', { projectPath: outside }),
      /outside/,
    );
    const abort = new AbortController();
    // Abort at configuration save, after installer files have been staged/published.
    let checks = 0;
    const signal = {
      throwIfAborted() {
        if (++checks === 3) {
          abort.abort();
          abort.signal.throwIfAborted();
        }
      },
    };
    await assert.rejects(changeAddon(root, scripts, false, {}, signal));
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), project);
    assert.equal(data(await call(root, 'get_annotation_status')).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function seed(root, id = 'a'.repeat(32)) {
  const directory = join(root, '.godot-mcp/annotations', id);
  await mkdir(directory, { recursive: true });
  const record = {
    schemaVersion: 1,
    captureId: id,
    source: 'runtime',
    scenePath: 'res://scene.tscn',
    createdAt: '2026-10-08T12:00:00Z',
    width: 1,
    height: 1,
    annotations: [
      {
        kind: 'pin',
        region: { x: 0.5, y: 0.5, width: 0, height: 0 },
        comment: 'Move this higher',
        nodePath: 'HUD/Button',
      },
      {
        kind: 'rectangle',
        region: { x: 0, y: 0, width: 1, height: 1 },
        comment: 'Change the background',
      },
    ],
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(join(directory, 'record.json'), JSON.stringify(record));
  for (const name of ['original', 'marked']) await writeFile(join(directory, `${name}.png`), png);
  return { directory, record, id };
}
test('submitted records paginate, return images, persist status and reject stale/malformed writes', async () => {
  const root = await fixture();
  try {
    assert.deepEqual(data(await call(root, 'list_annotations')).annotations, []);
    const { directory, record, id } = await seed(root);
    const listed = data(await call(root, 'list_annotations', { limit: 1 }));
    assert.equal(listed.annotations.length, 1);
    assert.equal(listed.nextCursor, `${id}-00`);
    assert.equal(
      data(await call(root, 'list_annotations', { cursor: listed.nextCursor })).annotations[0]
        .annotationId,
      `${id}-01`,
    );
    const fetched = await call(root, 'get_annotation', { annotationId: `${id}-00` });
    assert.deepEqual(
      fetched.content.map((item) => item.type),
      ['text', 'image', 'image'],
    );
    assert.equal(fetched.structuredContent.nodePath, 'HUD/Button');
    const resolved = data(
      await call(root, 'resolve_annotation', {
        annotationId: `${id}-00`,
        expectedRevision: fetched.structuredContent.revision,
        status: 'resolved',
      }),
    );
    assert.equal(data(await call(root, 'list_annotations')).annotations.length, 1);
    assert.equal(
      data(await call(root, 'get_annotation', { annotationId: `${id}-00` })).status,
      'resolved',
    );
    await assert.rejects(
      call(root, 'resolve_annotation', {
        annotationId: `${id}-01`,
        expectedRevision: fetched.structuredContent.revision,
        status: 'resolved',
      }),
      /revision changed/,
    );
    await call(root, 'resolve_annotation', {
      annotationId: `${id}-00`,
      expectedRevision: resolved.revision,
      status: 'open',
    });
    await assert.rejects(call(root, 'get_annotation', { annotationId: '../outside' }), /Invalid/);
    record.annotations[0].region.x = 2;
    await writeFile(join(directory, 'record.json'), JSON.stringify(record));
    assert.equal(data(await call(root, 'list_annotations')).errors.length, 1);
    await assert.rejects(call(root, 'get_annotation', { annotationId: `${id}-00` }), /normalized/);
    record.annotations[0].region.x = 0.5;
    await writeFile(join(directory, 'record.json'), JSON.stringify(record));
    await rm(join(directory, 'original.png'));
    await symlink(join(root, 'project.godot'), join(directory, 'original.png'));
    await assert.rejects(
      call(root, 'get_annotation', { annotationId: `${id}-00` }),
      /regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('annotation tools are discoverable and executable through MCP; read-only blocks setup', {
  timeout: 15000,
}, async () => {
  const root = await fixture();
  try {
    for (const readOnly of [false, true]) {
      const client = new Client({ name: 'annotation-test', version: '1' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['build/index.js'],
        env: {
          ...process.env,
          GODOT_PATH: process.execPath,
          GODOT_READ_ONLY: String(readOnly),
          GODOT_ALLOWED_ROOTS: root,
        },
        stderr: 'ignore',
      });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        assert.ok(listed.tools.some((item) => item.name === 'ensure_annotation_addon'));
        const installed = await client.callTool({
          name: 'ensure_annotation_addon',
          arguments: { projectPath: root, dryRun: true },
        });
        assert.equal(installed.isError === true, readOnly);
        assert.notEqual(
          (await client.callTool({ name: 'list_annotations', arguments: { projectPath: root } }))
            .isError,
          true,
        );
      } finally {
        await client.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runEngine(root, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(godot, ['--path', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Godot timeout: ${output}`));
    }, 15000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveRun({ code, output });
    });
  });
}
test('real Godot panel maps letterboxed regions, submits immutable images and cleans runtime pause', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    await writeFile(
      join(root, 'check.gd'),
      `extends SceneTree
func _initialize():
    call_deferred("check")
func check():
    var panel = load("res://addons/godot_mcp_annotations/panel.tscn").instantiate()
    root.add_child(panel)
    panel.configure(false)
    var image = Image.create(720, 1280, false, Image.FORMAT_RGB8)
    image.fill(Color.DARK_BLUE)
    panel.set_capture(image, {"source": "runtime", "scenePath": "res://scene.tscn"})
    await process_frame
    var canvas = panel.get_node("AnnotationCanvas")
    canvas.size = Vector2(800, 400)
    var rect = canvas.image_rect()
    assert(is_equal_approx(rect.size.x, 225.0))
    assert(is_equal_approx(rect.position.x, 287.5))
    var event = InputEventMouseButton.new()
    event.button_index = MOUSE_BUTTON_LEFT
    event.pressed = true
    event.position = rect.position + rect.size * Vector2(0.25, 0.25)
    canvas._gui_input(event)
    event.pressed = false
    event.position = rect.position + rect.size * Vector2(0.75, 0.75)
    canvas._gui_input(event)
    assert(is_equal_approx(panel.pending_region.x, 0.25))
    assert(is_equal_approx(panel.pending_region.width, 0.5))
    panel.get_node("Comment").text = "Move this higher"
    panel.add_comment()
    assert(panel.dirty)
    panel.submit()
    assert(not panel.dirty)
    var overlay = load("res://addons/godot_mcp_annotations/runtime.tscn").instantiate()
    root.add_child(overlay)
    overlay.get_node("AnnotationModal/ModalScroll/AnnotationPanel").dirty = true
    overlay.open_panel()
    assert(paused)
    overlay.close_panel()
    assert(not paused)
    overlay.queue_free()
    panel.queue_free()
    await process_frame
    print("ANNOTATION_UI_OK")
    quit()
`,
    );
    const checked = await runEngine(root, ['--headless', '--script', 'check.gd']);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /SCRIPT ERROR|Parse Error|ERROR:/);
    assert.match(checked.output, /ANNOTATION_UI_OK/);
    const listed = data(await call(root, 'list_annotations'));
    assert.equal(listed.annotations.length, 1, JSON.stringify(listed));
    assert.equal(listed.annotations[0].comment, 'Move this higher');
    const result = await call(root, 'get_annotation', {
      annotationId: listed.annotations[0].annotationId,
    });
    assert.notEqual(result.content[1].data, result.content[2].data);
    // Parse every editor/runtime script in the installed project too.
    for (const name of ['plugin.gd', 'game_session.gd']) {
      const checked = await runEngine(root, [
        '--headless',
        '--check-only',
        '--script',
        `res://addons/godot_mcp_annotations/${name}`,
      ]);
      assert.equal(checked.code, 0, checked.output);
      assert.doesNotMatch(checked.output, /SCRIPT ERROR|Parse Error|ERROR:/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real editor activates installed addon and publishes readiness', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    const checked = await runEngine(root, ['--headless', '--editor', '--quit-after', '30']);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /SCRIPT ERROR|Parse Error|ERROR:/);
    const status = data(await call(root, 'get_annotation_status'));
    assert.equal(status.installed, true);
    assert.equal(status.enabled, true);
    assert.equal(status.editorReady, false); // Graceful exit removes presence.
    // Generated UID sidecars do not break repeated installation.
    assert.equal((await changeAddon(root, scripts, false, {})).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rendered temporary session captures through annotation UI without installing addon', {
  skip: !godot || !render,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene format=3]\n[node name="Game" type="ColorRect"]\noffset_right=720.0\noffset_bottom=1280.0\ncolor=Color(0.05,0.1,0.3,1)\n',
    );
    await writeFile(
      join(root, 'render.gd'),
      `extends SceneTree
func _initialize():
    call_deferred("check")
func check():
    var scene = load("res://scene.tscn").instantiate()
    root.add_child(scene)
    current_scene = scene
    var overlay = load(${JSON.stringify(join(scripts, 'annotation_addon/runtime.tscn'))}).instantiate()
    root.add_child(overlay)
    await process_frame
    await overlay.open_panel()
    assert(paused)
    var panel = overlay.get_node("AnnotationModal/ModalScroll/AnnotationPanel")
    assert(panel.canvas.image != null)
    panel.pending_region = {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}
    panel.get_node("Comment").text = "Rendered game capture"
    panel.add_comment()
    await process_frame
    await RenderingServer.frame_post_draw
    root.get_texture().get_image().save_png("res://annotation-ui.png")
    panel.submit()
    assert(not panel.dirty)
    overlay.close_panel()
    assert(not paused)
    await process_frame
    print("RENDER_CAPTURE_OK")
    quit()
`,
    );
    const checked = await runEngine(root, [
      '--rendering-method',
      'gl_compatibility',
      '--script',
      'render.gd',
    ]);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /SCRIPT ERROR|Parse Error|ERROR:/);
    assert.match(checked.output, /RENDER_CAPTURE_OK/);
    assert.equal(
      data(await call(root, 'list_annotations')).annotations[0].comment,
      'Rendered game capture',
    );
    if (process.env.ANNOTATION_SCREENSHOT_DIR)
      await cp(
        join(root, 'annotation-ui.png'),
        join(process.env.ANNOTATION_SCREENSHOT_DIR, 'annotation-ui.png'),
      );
    assert.equal(data(await call(root, 'get_annotation_status')).installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editor game launch arguments preserve user arguments and create a temporary overlay', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Game" type="Node"]\nscript=ExtResource("1")\n',
    );
    await writeFile(
      join(root, 'scene.gd'),
      `extends Node
func _ready():
    call_deferred("check_overlay")
func check_overlay():
    await get_tree().process_frame
    assert(get_tree().root.has_node("MCPAnnotations"))
    assert("retained-user-argument" in OS.get_cmdline_user_args())
    print("EDITOR_GAME_OVERLAY_OK")
    get_tree().quit()
`,
    );
    await editorDriver(
      root,
      `func check():
    for frame in 60:
        await get_tree().process_frame
    while EditorInterface.get_resource_filesystem().is_scanning():
        await get_tree().process_frame
    var plugin = load("res://addons/godot_mcp_annotations/plugin.gd").new()
    var custom = PackedStringArray(["--script", "custom.gd"])
    assert(plugin._run_scene("res://scene.tscn", custom) == custom)
    var args = plugin._run_scene("res://scene.tscn", PackedStringArray(["--headless", "--", "retained-user-argument"]))
    var file = FileAccess.open("res://arguments.json", FileAccess.WRITE)
    file.store_string(JSON.stringify(Array(args)))
    file.close()
    plugin.free()
    get_tree().quit()
`,
    );
    const first = await runEngine(root, ['--headless', '--editor']);
    assert.equal(first.code, 0, first.output);
    assert.doesNotMatch(first.output, /SCRIPT ERROR|ERROR:/);
    const args = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8'));
    const played = await runEngine(root, args);
    assert.equal(played.code, 0, played.output);
    assert.doesNotMatch(played.output, /SCRIPT ERROR|ERROR:/);
    assert.match(played.output, /EDITOR_GAME_OVERLAY_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exported pack excludes annotation resources and local submitted data', {
  skip: !godot || process.env.GODOT_TEST_EXPORT !== 'true',
  timeout: 30000,
}, async () => {
  const root = await fixture();
  const reader = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    await seed(root);
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene format=3]\n[node name="Game" type="Node"]\n',
    );
    await writeFile(
      join(root, 'export_presets.cfg'),
      '[preset.0]\nname="Web"\nplatform="Web"\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path=""\n[preset.0.options]\nvariant/extensions_support=false\n',
    );
    await changeAddon(root, scripts, false, {});
    const exported = await runEngine(root, [
      '--headless',
      '--editor',
      '--export-pack',
      'Web',
      join(root, 'game.pck'),
    ]);
    assert.equal(exported.code, 0, exported.output);
    assert.doesNotMatch(exported.output, /SCRIPT ERROR|Parse Error|ERROR:/);
    await writeFile(
      join(reader, 'check.gd'),
      `extends SceneTree
func _initialize():
    assert(ProjectSettings.load_resource_pack(${JSON.stringify(join(root, 'game.pck'))}))
    assert(ResourceLoader.exists("res://scene.tscn"))
    assert(not ResourceLoader.exists("res://addons/godot_mcp_annotations/runtime.tscn"))
    assert(not FileAccess.file_exists("res://addons/godot_mcp_annotations/runtime.gd"))
    assert(not FileAccess.file_exists("res://.godot-mcp/annotations/${'a'.repeat(32)}/record.json"))
    print("ANNOTATION_EXPORT_OK")
    quit()
`,
    );
    const checked = await runEngine(reader, ['--headless', '--script', 'check.gd']);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /SCRIPT ERROR|ERROR:/);
    assert.match(checked.output, /ANNOTATION_EXPORT_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(reader, { recursive: true, force: true });
  }
});

test('rendered editor 2D and 3D viewport captures submit through the installed addon', {
  skip: !godot || !render,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene format=3]\n[node name="Scene" type="Node2D"]\n[node name="Color" type="ColorRect" parent="."]\noffset_right=200.0\noffset_bottom=200.0\ncolor=Color(1,0,0,1)\n',
    );
    await editorDriver(
      root,
      `func _process(_delta):
    # Keep this unattended editor fixture drawing without changing global editor preferences.
    EditorInterface.get_base_control().queue_redraw()
func find_annotation_plugin(node):
    var script = node.get_script()
    if script != null and script.resource_path == "res://addons/godot_mcp_annotations/plugin.gd":
        return node
    for child in node.get_children():
        var found = find_annotation_plugin(child)
        if found != null:
            return found
    return null
func check():
    for frame in 60:
        await get_tree().process_frame
    while EditorInterface.get_resource_filesystem().is_scanning():
        await get_tree().process_frame
    EditorInterface.open_scene_from_path("res://scene.tscn")
    var plugin = find_annotation_plugin(get_tree().root)
    assert(plugin != null)
    for source in ["editor_2d", "editor_3d"]:
        EditorInterface.set_main_screen_editor("2D" if source == "editor_2d" else "3D")
        for frame in 3:
            await get_tree().process_frame
        await plugin.capture(source)
        var panel = plugin.panel
        assert(panel.canvas.image != null)
        assert(panel.context.source == source)
        panel.pending_region = {"x": 0.5, "y": 0.5, "width": 0, "height": 0}
        panel.canvas.kind = "pin"
        panel.get_node("Comment").text = "Editor capture: " + source
        panel.add_comment()
        panel.submit()
        assert(not panel.dirty)
    print("EDITOR_VIEWPORT_CAPTURE_OK")
    get_tree().quit()
`,
    );
    const checked = await runEngine(root, ['--editor', '--rendering-method', 'gl_compatibility']);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /SCRIPT ERROR|ERROR:/);
    assert.match(checked.output, /EDITOR_VIEWPORT_CAPTURE_OK/);
    const listed = data(await call(root, 'list_annotations'));
    assert.deepEqual(listed.annotations.map((item) => item.source).sort(), [
      'editor_2d',
      'editor_3d',
    ]);
    for (const item of listed.annotations) {
      const fetched = await call(root, 'get_annotation', { annotationId: item.annotationId });
      assert.equal(fetched.content[1].type, 'image');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer adds export exclusions with guards, preserves other filters and rolls them back on failure', async () => {
  const root = await fixture();
  const original =
    '[preset.0]\nname="Web"\nexclude_filter="build/**" ; preserve\n[preset.0.options]\nvariant/extensions_support=false\n';
  try {
    await writeFile(join(root, 'export_presets.cfg'), original);
    const preview = await changeAddon(root, scripts, false, { dryRun: true });
    assert.equal(preview.exportExclusionsUpdated, true);
    assert.equal(await readFile(join(root, 'export_presets.cfg'), 'utf8'), original);
    await assert.rejects(
      changeAddon(root, scripts, false, { expectedExportHash: 'stale' }),
      /Export presets hash changed/,
    );
    let checks = 0;
    const signal = {
      throwIfAborted() {
        if (++checks === 5) throw new Error('cancelled after export save');
      },
    };
    await assert.rejects(changeAddon(root, scripts, false, {}, signal), /cancelled/);
    assert.equal(await readFile(join(root, 'project.godot'), 'utf8'), project);
    assert.equal(await readFile(join(root, 'export_presets.cfg'), 'utf8'), original);
    await changeAddon(root, scripts, false, { expectedExportHash: preview.exportSourceHash });
    const exclusions = await readFile(join(root, 'export_presets.cfg'), 'utf8');
    assert.ok(
      exclusions.includes('build/**,addons/godot_mcp_annotations/*,.godot-mcp/*" ; preserve'),
    );
    assert.equal((await changeAddon(root, scripts, false, {})).changed, false);
    await changeAddon(root, scripts, true, {});
    assert.equal(await readFile(join(root, 'export_presets.cfg'), 'utf8'), exclusions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('temporary debug-session annotation option runs the actual MCP bridge and persists a submitted frame', {
  skip: !godot || !render,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  const client = new Client({ name: 'runtime-annotation-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: { ...process.env, GODOT_PATH: godot, GODOT_ALLOWED_ROOTS: root },
    stderr: 'ignore',
  });
  try {
    // An explicit session scene must replace the configured main scene before startup.
    await writeFile(
      join(root, 'project.godot'),
      project.replace(
        'config/name="MCP annotation tests"',
        'config/name="MCP annotation tests"\nrun/main_scene="res://wrong.tscn"',
      ),
    );
    await writeFile(
      join(root, 'wrong.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://wrong.gd" id="1"]\n[node name="Wrong" type="Node"]\nscript=ExtResource("1")\n',
    );
    await writeFile(
      join(root, 'wrong.gd'),
      'extends Node\nfunc _ready():\n    get_tree().set_meta("wrong_started", true)\n',
    );
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Game" type="Node"]\nscript=ExtResource("1")\n',
    );
    await writeFile(
      join(root, 'scene.gd'),
      `extends Node
func _ready():
    assert(not get_tree().has_meta("wrong_started"))
    assert(not get_tree().has_meta("game_started"))
    get_tree().set_meta("game_started", true)
    call_deferred("annotate")
func annotate():
    await get_tree().process_frame
    var overlay = get_tree().root.get_node("MCPAnnotations")
    await overlay.open_panel()
    var panel = overlay.get_node("AnnotationModal/ModalScroll/AnnotationPanel")
    panel.pending_region = {"x":0.5,"y":0.5,"width":0,"height":0}
    panel.canvas.kind = "pin"
    panel.get_node("Comment").text = "MCP bridge capture"
    panel.add_comment()
    panel.submit()
    overlay.close_panel()
`,
    );
    await client.connect(transport);
    const started = await client.callTool({
      name: 'start_debug_session',
      arguments: { projectPath: root, scenePath: 'scene.tscn', annotations: true, headless: false },
    });
    assert.notEqual(started.isError, true, JSON.stringify(started));
    let listed;
    const deadline = Date.now() + 5000;
    do {
      listed = await client.callTool({
        name: 'list_annotations',
        arguments: { projectPath: root },
      });
      if (listed.structuredContent.annotations.length) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    } while (Date.now() < deadline);
    assert.equal(listed.structuredContent.annotations[0].comment, 'MCP bridge capture');
    await client.callTool({ name: 'stop_project', arguments: {} });
    const fetched = await client.callTool({
      name: 'get_annotation',
      arguments: {
        projectPath: root,
        annotationId: listed.structuredContent.annotations[0].annotationId,
      },
    });
    assert.notEqual(fetched.isError, true, JSON.stringify(fetched));
    assert.equal(fetched.content[1].type, 'image');
    assert.equal(data(await call(root, 'get_annotation_status')).installed, false);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ensure re-enables an already installed disabled addon and distinguishes live activation', async () => {
  const root = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    const settings = await readFile(join(root, 'project.godot'), 'utf8');
    await writeFile(
      join(root, 'project.godot'),
      settings.replace('"res://addons/godot_mcp_annotations/plugin.cfg"', ''),
    );
    const ensured = await changeAddon(root, scripts, false, {});
    assert.equal(ensured.configuredEnabled, true);
    assert.equal(ensured.editorReady, false);
    assert.equal(ensured.activation, 'editor_reload_required');
    assert.ok(
      (await readFile(join(root, 'project.godot'), 'utf8')).includes(
        '"res://addons/godot_mcp_annotations/plugin.cfg"',
      ),
    );
    assert.equal((await changeAddon(root, scripts, false, {})).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensure reports pending activation in an open editor and enables the plugin after reopen', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await changeAddon(root, scripts, false, {});
    await editorDriver(
      root,
      `var frames = 0
func _process(_delta):
    frames += 1
    if frames < 30:
        return
    if FileAccess.file_exists("res://check.flag"):
        var file = FileAccess.open("res://observed.json", FileAccess.WRITE)
        file.store_string(JSON.stringify({"liveEnabled": EditorInterface.is_plugin_enabled("godot_mcp_annotations")}))
        file.close()
        get_tree().quit()
    elif not FileAccess.file_exists("res://ready.flag"):
        var file = FileAccess.open("res://ready.flag", FileAccess.WRITE)
        file.close()
func check():
    pass
`,
    );
    const settings = await readFile(join(root, 'project.godot'), 'utf8');
    await writeFile(
      join(root, 'project.godot'),
      settings.replace('"res://addons/godot_mcp_annotations/plugin.cfg", ', ''),
    );
    const running = runEngine(root, ['--headless', '--editor']);
    // Attach a rejection handler while waiting for editor readiness.
    running.catch(() => {});
    const deadline = Date.now() + 10000;
    while (!(await readFile(join(root, 'ready.flag')).catch(() => null))) {
      assert.ok(Date.now() < deadline, 'Editor did not become ready');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const ensured = await changeAddon(root, scripts, false, {});
    await writeFile(join(root, 'check.flag'), '');
    const first = await running;
    assert.equal(first.code, 0, first.output);
    const observed = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
    assert.equal(ensured.configuredEnabled, true);
    assert.equal(observed.liveEnabled, false);
    assert.equal(ensured.editorReady, false);
    assert.equal(ensured.activation, 'editor_reload_required');
    const reopened = await runEngine(root, ['--headless', '--editor']);
    assert.equal(reopened.code, 0, reopened.output);
    const after = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
    assert.equal(after.liveEnabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('released draft rectangles and pins stay yellow until added or cleared', {
  skip: !godot || !render,
  timeout: 20000,
}, async () => {
  const root = await fixture();
  try {
    const checked = await runEngine(root, [
      '--rendering-method',
      'gl_compatibility',
      '--script',
      resolve('tests/fixtures/annotation_draft.gd'),
      '--',
      join(scripts, 'annotation_addon'),
    ]);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /SCRIPT ERROR|ERROR:/);
    assert.match(checked.output, /ANNOTATION_DRAFT_RENDER_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editor wrapper loads the requested game only once and retains overlay across transitions', {
  skip: !godot,
  timeout: 30000,
}, async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'project.godot'),
      project.replace(
        'config/name="MCP annotation tests"',
        'config/name="MCP annotation tests"\nrun/main_scene="res://scene.tscn"',
      ),
    );
    await changeAddon(root, scripts, false, {});
    await writeFile(
      join(root, 'scene.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://scene.gd" id="1"]\n[node name="Game" type="Node"]\nscript=ExtResource("1")\n',
    );
    await writeFile(
      join(root, 'next.tscn'),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://next.gd" id="1"]\n[node name="Next" type="Node"]\nscript=ExtResource("1")\n',
    );
    await writeFile(
      join(root, 'scene.gd'),
      `extends Node
func _ready():
    var count = int(get_tree().get_meta("starts", 0)) + 1
    get_tree().set_meta("starts", count)
    print("GAME_STARTED_", count)
    call_deferred("join_world")
func join_world():
    get_tree().change_scene_to_file("res://next.tscn")
`,
    );
    await writeFile(
      join(root, 'next.gd'),
      `extends Node
func _ready():
    call_deferred("check")
func check():
    assert(get_tree().get_meta("starts") == 1)
    assert(get_tree().root.has_node("MCPAnnotations"))
    print("SINGLE_START_TRANSITION_OK")
    get_tree().quit()
`,
    );
    const played = await runEngine(root, [
      '--headless',
      '--quit-after',
      '60',
      '--scene',
      'res://scene.tscn',
      '--script',
      'res://addons/godot_mcp_annotations/game_session.gd',
      '--',
      '--godot-mcp-annotation-scene=res://scene.tscn',
    ]);
    assert.equal(played.code, 0, played.output);
    assert.doesNotMatch(played.output, /GAME_STARTED_2|SCRIPT ERROR|ERROR:/);
    assert.match(played.output, /SINGLE_START_TRANSITION_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
