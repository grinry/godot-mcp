import { join } from 'node:path';
import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';
import { nodePath } from './authoring-tools.js';
import { diagnosticCounts, parseDiagnostics } from './diagnostics.js';
import type { GodotSession } from './godot-session.js';
import { projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';
import { inputParameters } from './workflow-tools.js';

const tool = (
  name: string,
  description: string,
  properties: JSONObject,
  required: string[],
): ToolSpecification => ({
  name,
  annotations: { destructiveHint: name === 'quit_godot' },
  description,
  inputSchema: { type: 'object', properties, required },
  access: ['get_runtime_tree', 'view_log', 'get_performance_monitors'].includes(name)
    ? 'read'
    : ['close_session', 'quit_godot'].includes(name)
      ? 'control'
      : 'execute',
  session: name === 'start_debug_session' ? 'start' : 'use',
});
const project = { type: 'string' };
const scene = { type: 'string' };
export const runtimeTools: ToolSpecification[] = [
  {
    ...tool(
      'get_performance_monitors',
      'Read timestamped runtime Performance monitor values with units. Render metrics are unavailable under headless; this is a snapshot, not a function-level profiler.',
      {},
      [],
    ),
    outputSchema: {
      type: 'object',
      properties: {
        monitors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              unit: { type: 'string' },
              available: { type: 'boolean' },
            },
            required: ['name', 'value', 'unit', 'available'],
          },
        },
        sampledAtMs: { type: 'number' },
        paused: { type: 'boolean' },
      },
      required: ['monitors', 'sampledAtMs', 'paused'],
    },
  },
  tool(
    'get_runtime_tree',
    'Inspect the live debug session scene tree without changing pause state. Returns bounded node paths, classes and script paths.',
    {
      maxDepth: { type: 'integer', minimum: 0, maximum: 20 },
      maxNodes: { type: 'integer', minimum: 1, maximum: 200 },
    },
    [],
  ),
  tool(
    'close_session',
    'Stop and release an explicit process/debug session.',
    { sessionId: { type: 'string' } },
    ['sessionId'],
  ),
  tool(
    'start_debug_session',
    'Run a temporary live debug session. Does not install addons or change project settings. Replaces the current game run.',
    {
      projectPath: project,
      scenePath: scene,
      headless: { type: 'boolean' },
      annotations: {
        type: 'boolean',
        description:
          'Show the debug-only Annotate button; submitted frames persist locally. Requires display rendering.',
      },
    },
    ['projectPath'],
  ),
  tool(
    'capture_screenshot',
    'Capture the current live debug session as an inline PNG, including when paused. Requires a display renderer.',
    {},
    [],
  ),
  tool(
    'simulate_input',
    'Send input events to the live debug session only. Send pressed:false to release a held key, action or button.',
    {
      kind: { type: 'string', enum: ['action', 'key', 'mouse_button', 'mouse_motion'] },
      action: { type: 'string' },
      pressed: { type: 'boolean' },
      strength: { type: 'number', minimum: 0, maximum: 1 },
      keycode: { type: 'integer', minimum: 1 },
      button: { type: 'integer', minimum: 1, maximum: 9 },
      x: { type: 'number' },
      y: { type: 'number' },
    },
    ['kind'],
  ),
  tool(
    'set_debug_pause',
    'Pause or resume the live debug session. Captures do not change pause state.',
    { paused: { type: 'boolean' } },
    ['paused'],
  ),
  tool(
    'view_log',
    'Read bounded logs of the most recently launched editor, including after exit.',
    { lineCount: { type: 'integer', minimum: 1, maximum: 10000 } },
    [],
  ),
  tool(
    'quit_godot',
    'Terminate the editor launched by this server and wait for exit. Unsaved editor changes may be lost.',
    {},
    [],
  ),
  {
    name: 'get_node_properties',
    access: 'execute',
    session: 'use',
    description:
      'Read up to 50 named properties from a node in the live debug session; uses bounded typed values. Executes property getters. Does not change pause state.',
    inputSchema: {
      type: 'object',
      properties: {
        nodePath: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
      },
      required: ['nodePath', 'properties'],
    },
  },
  {
    name: 'step_frames',
    access: 'execute',
    session: 'use',
    description:
      'Advance a paused live session by 1 to 120 process or physics frames, then pause again. Counts frame boundaries; pause-ignoring nodes and external systems are not deterministic. Requires set_debug_pause first.',
    inputSchema: {
      type: 'object',
      properties: {
        frames: { type: 'integer', minimum: 1, maximum: 120 },
        kind: { type: 'string', enum: ['process', 'physics'] },
      },
      required: ['frames'],
    },
  },
];

const text = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
export async function handleRuntimeTool(
  name: string,
  args: Record<string, unknown>,
  session: GodotSession,
  godot: string,
  scripts: string,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (name === 'start_debug_session') {
    const root = await projectRoot(args.projectPath);
    const scene =
      args.scenePath === undefined
        ? ''
        : (await projectFile(root, args.scenePath, ['.tscn', '.scn'])).resource;
    if (args.headless !== undefined && typeof args.headless !== 'boolean')
      throw new Error('headless must be boolean');
    if (args.annotations !== undefined && typeof args.annotations !== 'boolean')
      throw new Error('annotations must be boolean');
    if (args.annotations === true && args.headless === true)
      throw new Error('Annotations require display rendering');
    return text(
      await session.live.start(
        godot,
        root,
        join(scripts, 'live_session.gd'),
        scene,
        args.headless === true,
        signal,
        args.annotations === true,
      ),
    );
  }
  if (name === 'close_session') {
    await session.close();
    return text({ closed: true });
  }
  if (name === 'quit_godot') {
    await session.editor.stop();
    return text(session.editor.current?.snapshot() ?? { running: false });
  }
  if (name === 'view_log') {
    const count = args.lineCount ?? 200;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10000)
      throw new Error('lineCount must be between 1 and 10000');
    const snapshot = session.editor.current?.snapshot();
    if (!snapshot) throw new Error('No editor has been launched');
    const diagnostics = [
      ...parseDiagnostics(snapshot.output),
      ...parseDiagnostics(snapshot.errors),
    ];
    return text({
      ...snapshot,
      diagnostics,
      counts: diagnosticCounts(diagnostics),
      output: snapshot.output.slice(-count),
      errors: snapshot.errors.slice(-count),
    });
  }
  if (name === 'get_runtime_tree') {
    const maxDepth = args.maxDepth ?? 10;
    const maxNodes = args.maxNodes ?? 100;
    if (
      typeof maxDepth !== 'number' ||
      !Number.isInteger(maxDepth) ||
      maxDepth < 0 ||
      maxDepth > 20 ||
      typeof maxNodes !== 'number' ||
      !Number.isInteger(maxNodes) ||
      maxNodes < 1 ||
      maxNodes > 200
    )
      throw new Error('Invalid runtime tree limits');
    return text(await session.live.request('tree', { maxDepth, maxNodes }, signal));
  }
  if (name === 'get_performance_monitors')
    return text(await session.live.request('performance', {}, signal));
  if (name === 'get_node_properties') {
    const path = nodePath(args.nodePath);
    if (
      !Array.isArray(args.properties) ||
      args.properties.length < 1 ||
      args.properties.length > 50 ||
      args.properties.some(
        (key) => typeof key !== 'string' || !key || key.length > 128 || key.includes('\0'),
      )
    )
      throw new Error('properties must contain 1 to 50 property names');
    return text(
      await session.live.request(
        'properties',
        { nodePath: path, properties: args.properties },
        signal,
      ),
    );
  }
  if (name === 'step_frames') {
    if (
      typeof args.frames !== 'number' ||
      !Number.isInteger(args.frames) ||
      args.frames < 1 ||
      args.frames > 120
    )
      throw new Error('frames must be between 1 and 120');
    const kind = args.kind ?? 'physics';
    if (kind !== 'physics' && kind !== 'process')
      throw new Error('kind must be physics or process');
    return text(await session.live.request('step', { frames: args.frames, kind }, signal));
  }
  if (name === 'simulate_input')
    return text(await session.live.request('input', inputParameters(args), signal));
  if (name === 'set_debug_pause') {
    if (typeof args.paused !== 'boolean') throw new Error('paused must be boolean');
    return text(await session.live.request('pause', { paused: args.paused }, signal));
  }
  if (name === 'capture_screenshot') {
    const result = await session.live.request('screenshot', {}, signal);
    const { image, ...metadata } = result;
    if (typeof image !== 'string') throw new Error('Bridge did not return an image');
    return {
      content: [
        { type: 'image', mimeType: 'image/png', data: image },
        { type: 'text', text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    };
  }
  throw new Error(`Unknown runtime tool: ${name}`);
}
