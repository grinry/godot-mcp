import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';
import { OperationRunner, processDiagnostics, processReport } from './operation-runner.js';
import { listProjectFiles } from './project-files.js';
import { projectDirectory, projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const project = { type: 'string', description: 'Godot project directory' };
const scene = { type: 'string', description: 'Relative or res:// PackedScene path' };
const timeout = { type: 'integer', minimum: 1, maximum: 600000 };

const tool = (
  name: string,
  description: string,
  properties: JSONObject,
  required: string[],
): ToolSpecification => ({
  access: name === 'list_project_files' ? 'read' : 'execute',
  session: name === 'run_scene' ? 'start' : 'none',
  name,
  description,
  inputSchema: { type: 'object', properties, required },
});
export const extraTools: ToolSpecification[] = [
  tool(
    'run_gut_tests',
    'Run installed GUT tests with bounded output, timeout and cancellation. Choose exactly one testFile or directory.',
    {
      projectPath: project,
      testFile: { type: 'string' },
      directory: { type: 'string' },
      includeSubdirs: { type: 'boolean' },
      headless: { type: 'boolean' },
      logLevel: { type: 'integer', minimum: 0, maximum: 3 },
      timeoutMs: timeout,
    },
    ['projectPath'],
  ),

  tool(
    'list_project_files',
    'Discover scenes, scripts and resources; excludes hidden directories and symlinks. Results are bounded.',
    {
      projectPath: project,
      type: { type: 'string', enum: ['all', 'scene', 'script', 'resource'] },
      pattern: { type: 'string', description: 'Relative glob (*, **, ?)' },
      limit: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    ['projectPath'],
  ),
  tool(
    'run_scene',
    'Run one scene; replaces the previous run and retains final debug output.',
    { projectPath: project, scenePath: scene, timeoutMs: timeout, headless: { type: 'boolean' } },
    ['projectPath', 'scenePath'],
  ),
  tool(
    'validate_project',
    'Check all or selected GDScript files using Godot --check-only. Choose scripts or pattern for targeted validation. Does not validate C# or gameplay.',
    {
      projectPath: project,
      timeoutMs: timeout,
      scripts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1000 },
      pattern: {
        type: 'string',
        description: 'Relative script glob; mutually exclusive with scripts',
      },
    },
    ['projectPath'],
  ),
  tool(
    'run_scene_test',
    'Run a headless test scene until it exits. Reports exit status, errors and timeout; test scripts must quit with their result code.',
    { projectPath: project, scenePath: scene, timeoutMs: timeout },
    ['projectPath', 'scenePath'],
  ),
  tool(
    'export_project',
    'Export using an existing preset and installed export templates. Writes the requested output file.',
    {
      projectPath: project,
      preset: { type: 'string' },
      outputPath: { type: 'string' },
      debug: { type: 'boolean' },
      timeoutMs: timeout,
    },
    ['projectPath', 'preset', 'outputPath'],
  ),
  tool(
    'capture_scene_screenshot',
    'Run a fresh scene and return its rendered viewport as a PNG image. Requires a display; does not capture an existing run.',
    {
      projectPath: project,
      scenePath: scene,
      frames: { type: 'integer', minimum: 1, maximum: 600 },
      timeoutMs: timeout,
    },
    ['projectPath', 'scenePath'],
  ),
];

function text(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
  };
}
function time(value: unknown, fallback = 60000) {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < 1 || result > 600000)
    throw new Error('timeoutMs must be between 1 and 600000');
  return result;
}
export async function handleExtraTool(
  name: string,
  args: Record<string, unknown>,
  godot: string,
  scripts: string,
  signal?: AbortSignal,
  runner = new OperationRunner(),
): Promise<CallToolResult> {
  const root = await projectRoot(args.projectPath);
  if (name === 'list_project_files') {
    return text(await listProjectFiles(root, { ...args, signal }));
  }
  const timeoutMs = time(args.timeoutMs);

  if (name === 'run_gut_tests') {
    const command = await gutArguments(root, args);
    const child = await runner.run(godot, command, timeoutMs, signal);
    const errors = processDiagnostics(child);
    const nothingRun = child.output.some((line) =>
      /Nothing was run|^Tests\s+(?:none|0)\s*$/i.test(line),
    );
    const passed =
      child.exitCode === 0 &&
      !child.timedOut &&
      !child.truncated &&
      !errors.some((item) => item.severity === 'error') &&
      !nothingRun;
    return text({ passed, nothingRun, ...processReport(child) }, !passed);
  }
  if (name === 'validate_project') {
    if (args.scripts !== undefined && args.pattern !== undefined)
      throw new Error('Choose scripts or pattern, not both');
    let paths: string[];
    if (args.scripts !== undefined) {
      if (!Array.isArray(args.scripts) || !args.scripts.length || args.scripts.length > 1000)
        throw new Error('scripts must contain 1 to 1000 paths');
      paths = [
        ...new Set(
          await Promise.all(
            args.scripts.map(
              async (path) => (await projectFile(root, path, ['.gd', '.gdscript'])).resource,
            ),
          ),
        ),
      ];
    } else {
      if (args.pattern !== undefined && (typeof args.pattern !== 'string' || !args.pattern))
        throw new Error('pattern must be a nonempty glob');
      const files = await listProjectFiles(root, {
        type: 'script',
        limit: 1000,
        pattern: args.pattern as string | undefined,
        signal,
      });
      if (files.truncated) throw new Error('Too many scripts: validation would be incomplete');
      paths = files.scripts
        .filter((file) => file.endsWith('.gd') || file.endsWith('.gdscript'))
        .map((file) => `res://${file}`);
    }
    if (!paths.length)
      return text(
        {
          valid: false,
          nothingChecked: true,
          results: [],
          diagnostics: [],
          counts: { errors: 0, warnings: 0 },
        },
        true,
      );
    const results = [];
    let resultBytes = 0;
    const deadline = Date.now() + timeoutMs;
    for (const path of paths) {
      if (Date.now() >= deadline) return text({ valid: false, timedOut: true, results }, true);
      const child = await runner.run(
        godot,
        ['--headless', '--path', root, '--check-only', '--script', path],
        Math.max(1, deadline - Date.now()),
        signal,
      );
      const result = { path, ...processReport(child) };
      resultBytes += Buffer.byteLength(JSON.stringify(result));
      if (resultBytes > 2 * 1024 * 1024)
        return text({ valid: false, truncated: true, results, uncheckedScript: path }, true);
      results.push(result);
      if (child.timedOut) break;
    }
    const valid = results.every(
      (result) =>
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.truncated &&
        result.counts.errors === 0,
    );
    const diagnostics = results.flatMap((item) => item.diagnostics);
    const counts = results.reduce(
      (sum, item) => ({
        errors: sum.errors + item.counts.errors,
        warnings: sum.warnings + item.counts.warnings,
      }),
      { errors: 0, warnings: 0 },
    );
    return text({ valid, checked: results.length, results, diagnostics, counts }, !valid);
  }
  if (name === 'export_project') {
    if (typeof args.preset !== 'string' || !args.preset || args.preset.startsWith('-'))
      throw new Error('preset is required');
    if (typeof args.outputPath !== 'string' || !args.outputPath || args.outputPath.includes('\0'))
      throw new Error('outputPath is required');
    if (args.debug !== undefined && typeof args.debug !== 'boolean')
      throw new Error('debug must be boolean');
    await stat(join(root, 'export_presets.cfg'));
    const outputPath = isAbsolute(args.outputPath)
      ? args.outputPath
      : resolve(root, args.outputPath);
    const child = await runner.run(
      godot,
      [
        '--headless',
        '--path',
        root,
        args.debug ? '--export-debug' : '--export-release',
        args.preset,
        outputPath,
      ],
      timeoutMs,
      signal,
    );
    const errors = processDiagnostics(child);
    const success =
      child.exitCode === 0 &&
      !child.timedOut &&
      !child.truncated &&
      !errors.some((item) => item.severity === 'error') &&
      (await stat(outputPath).catch(() => null))?.isFile() === true;
    return text({ success, outputPath, ...processReport(child) }, !success);
  }
  const resource = await projectFile(root, args.scenePath, ['.tscn', '.scn']);
  if (name === 'run_scene_test') {
    const child = await runner.run(
      godot,
      ['--headless', '--path', root, resource.resource],
      timeoutMs,
      signal,
    );
    const errors = processDiagnostics(child);
    const passed =
      child.exitCode === 0 &&
      !child.timedOut &&
      !child.truncated &&
      !errors.some((item) => item.severity === 'error');
    return text({ passed, ...processReport(child) }, !passed);
  }
  if (name === 'capture_scene_screenshot') {
    const frames = args.frames ?? 3;
    if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > 600)
      throw new Error('frames must be between 1 and 600');
    const directory = await mkdtemp(join(tmpdir(), 'godot-mcp-capture-'));
    try {
      const output = join(directory, 'capture.png');
      const child = await runner.run(
        godot,
        [
          '--path',
          root,
          '--script',
          join(scripts, 'capture_scene.gd'),
          '--',
          resource.resource,
          output,
          String(frames),
        ],
        time(args.timeoutMs, 30000),
        signal,
      );
      if (child.exitCode !== 0 || child.timedOut) return text(child.snapshot(), true);
      const size = (await stat(output)).size;
      if (size > 8 * 1024 * 1024) throw new Error('Screenshot exceeds 8 MiB');
      return {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: (await readFile(output)).toString('base64'),
          },
          {
            type: 'text',
            text: JSON.stringify({ scene: resource.resource, frames, errors: child.errors }),
          },
        ],
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function inputParameters(args: Record<string, unknown>) {
  const pressed = args.pressed ?? true;
  if (typeof pressed !== 'boolean') throw new Error('pressed must be boolean');
  const number = (key: string, min: number, max: number, integer = false, fallback?: number) => {
    const value = args[key] ?? fallback;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(`Invalid ${key}`);
    return value;
  };
  switch (args.kind) {
    case 'action':
      if (typeof args.action !== 'string' || !args.action || args.action.length > 256)
        throw new Error('action is required');
      return {
        kind: args.kind,
        action: args.action,
        pressed,
        strength: number('strength', 0, 1, false, 1),
      };
    case 'key':
      return { kind: args.kind, keycode: number('keycode', 1, 0x7fffffff, true), pressed };
    case 'mouse_button':
      return {
        kind: args.kind,
        button: number('button', 1, 9, true, 1),
        x: number('x', -1000000, 1000000),
        y: number('y', -1000000, 1000000),
        pressed,
      };
    case 'mouse_motion':
      return {
        kind: args.kind,
        x: number('x', -1000000, 1000000),
        y: number('y', -1000000, 1000000),
      };
    default:
      throw new Error('Invalid input kind');
  }
}

export async function gutArguments(root: string, args: Record<string, unknown>) {
  const runner = await projectFile(root, 'res://addons/gut/gut_cmdln.gd', ['.gd']).catch(() => {
    throw new Error('Install GUT in addons/gut before running tests');
  });
  if ((args.testFile === undefined) === (args.directory === undefined))
    throw new Error('Choose exactly one testFile or directory');
  const resource =
    args.testFile !== undefined
      ? await projectFile(root, args.testFile, ['.gd'])
      : await projectDirectory(root, args.directory);
  if (resource.resource.includes(',')) throw new Error('GUT paths cannot contain commas');
  const headless = args.headless ?? true;
  const include = args.includeSubdirs ?? true;
  const log = args.logLevel ?? 1;
  if (typeof headless !== 'boolean' || typeof include !== 'boolean')
    throw new Error('headless and includeSubdirs must be boolean');
  if (typeof log !== 'number' || !Number.isInteger(log) || log < 0 || log > 3)
    throw new Error('logLevel must be between 0 and 3');
  return [
    ...(headless ? ['--headless'] : []),
    '--path',
    root,
    '--script',
    runner.resource,
    `${args.testFile !== undefined ? '-gtest' : '-gdir'}=${resource.resource}`,
    `-ginclude_subdirs=${include}`,
    `-glog=${log}`,
    '-gdisable_colors',
    '-gexit',
  ];
}
