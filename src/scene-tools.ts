import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { nodePath } from './authoring-tools.js';
import { type OperationRunner, requireSuccess } from './operation-runner.js';
import { projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const string = { type: 'string' };
const scene = { projectPath: string, scenePath: string };
const operation = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: [
        'set_properties',
        'remove_node',
        'rename_node',
        'reparent_node',
        'connect_signal',
        'disconnect_signal',
        'add_group',
        'remove_group',
      ],
    },
    nodePath: string,
    properties: { type: 'object' },
    newName: string,
    parentNodePath: string,
    signal: string,
    targetNodePath: string,
    method: string,
    group: string,
  },
  required: ['op', 'nodePath'],
  additionalProperties: false,
};
export const sceneTools: ToolSpecification[] = [
  {
    name: 'get_scene_info',
    access: 'execute',
    session: 'none',
    description:
      'Inspect a saved PackedScene without instantiating it: serialized hierarchy, properties, scripts, groups, connections and dependencies. Loading resources/autoloads may execute project code. Bounded results include inheritance and instances.',
    inputSchema: {
      type: 'object',
      properties: {
        ...scene,
        maxNodes: { type: 'integer', minimum: 1, maximum: 500 },
        maxProperties: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['projectPath', 'scenePath'],
    },
  },
  {
    name: 'set_node_properties',
    access: 'execute',
    session: 'none',
    description:
      'Set stored properties on an existing local scene node using typed JSON values; saves once after validation. Executes constructors. Refuses inherited/instanced edits and unsupported property types.',
    inputSchema: {
      type: 'object',
      properties: {
        ...scene,
        nodePath: string,
        properties: { type: 'object' },
        dryRun: { type: 'boolean' },
        expectedHash: string,
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'properties'],
    },
  },
  {
    name: 'modify_scene',
    access: 'execute',
    session: 'none',
    description:
      'Apply up to 100 scene operations in order and save once, or preview with dryRun. Supports properties, remove/rename/reparent, persistent signals and groups. Executes constructors. Refuses inherited/instanced edits and removal of referenced nodes. expectedHash guards stale previews.',
    inputSchema: {
      type: 'object',
      properties: {
        ...scene,
        operations: { type: 'array', items: operation, minItems: 1, maxItems: 100 },
        dryRun: { type: 'boolean' },
        expectedHash: string,
      },
      required: ['projectPath', 'scenePath', 'operations'],
    },
  },
];

const operations = new Set([
  'set_properties',
  'remove_node',
  'rename_node',
  'reparent_node',
  'connect_signal',
  'disconnect_signal',
  'add_group',
  'remove_group',
]);
function identifier(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function validateOperations(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new Error('operations must contain 1 to 100 entries');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !operations.has(entry.op))
      throw new Error('Invalid scene operation');
    const result: Record<string, unknown> = { op: entry.op, nodePath: nodePath(entry.nodePath) };
    if (entry.op === 'set_properties') {
      if (
        !entry.properties ||
        typeof entry.properties !== 'object' ||
        Array.isArray(entry.properties) ||
        Object.keys(entry.properties).length < 1 ||
        Object.keys(entry.properties).length > 100
      )
        throw new Error('properties must contain 1 to 100 entries');
      result.properties = entry.properties;
    } else if (entry.op === 'rename_node') {
      if (
        typeof entry.newName !== 'string' ||
        !entry.newName ||
        entry.newName.length > 128 ||
        /[.:/@"%\\]/.test(entry.newName) ||
        [...entry.newName].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error('Invalid newName');
      result.newName = entry.newName;
    } else if (entry.op === 'reparent_node') result.parentNodePath = nodePath(entry.parentNodePath);
    else if (entry.op.endsWith('_signal')) {
      result.signal = identifier(entry.signal, 'signal');
      result.targetNodePath = nodePath(entry.targetNodePath);
      result.method = identifier(entry.method, 'method');
    } else if (entry.op.endsWith('_group')) {
      if (
        typeof entry.group !== 'string' ||
        !entry.group ||
        entry.group.length > 128 ||
        entry.group.includes('\0') ||
        entry.group.startsWith('_')
      )
        throw new Error('Invalid group');
      result.group = entry.group;
    }
    return result;
  });
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const sceneQueues = new Map<string, Promise<void>>();

/** Serialize edits by canonical path across sessions, including stale-preview checks. */
export async function handleSceneTool(
  name: string,
  args: Record<string, unknown>,
  godot: string,
  scripts: string,
  runner: OperationRunner,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const root = await projectRoot(args.projectPath);
  const file = await projectFile(root, args.scenePath, ['.tscn', '.scn']);
  const previous = sceneQueues.get(file.path) ?? Promise.resolve();
  const operation = previous.then(() => {
    signal?.throwIfAborted();
    return runSceneTool(name, args, godot, scripts, runner, signal);
  });
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  sceneQueues.set(file.path, settled);
  try {
    return await operation;
  } finally {
    if (sceneQueues.get(file.path) === settled) sceneQueues.delete(file.path);
  }
}

async function runSceneTool(
  name: string,
  args: Record<string, unknown>,
  godot: string,
  scripts: string,
  runner: OperationRunner,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const root = await projectRoot(args.projectPath);
  const file = await projectFile(root, args.scenePath, ['.tscn', '.scn']);
  const original = await readFile(file.path);
  const sourceHash = hash(original);
  const inspecting = name === 'get_scene_info';
  const params: Record<string, unknown> = { scenePath: file.resource };
  if (inspecting) {
    for (const [key, fallback, max] of [
      ['maxNodes', 100, 500],
      ['maxProperties', 50, 200],
    ] as const) {
      const value = args[key] ?? fallback;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
        throw new Error(`Invalid ${key}`);
      params[key] = value;
    }
  } else {
    if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')
      throw new Error('dryRun must be boolean');
    if (args.expectedHash !== undefined && args.expectedHash !== sourceHash)
      throw new Error('Scene changed since preview; inspect it again');
    params.operations = validateOperations(
      name === 'set_node_properties'
        ? [{ op: 'set_properties', nodePath: args.nodePath, properties: args.properties }]
        : args.operations,
    );
    // Resource paths nested in typed resource values must pass the same confinement check.
    const visit = async (value: unknown, depth = 0): Promise<void> => {
      if (depth > 16) throw new Error('Property nesting exceeds limit');
      if (value && typeof value === 'object') {
        if ('type' in value && value.type === 'Resource' && 'path' in value)
          await projectFile(root, value.path);
        for (const child of Object.values(value)) await visit(child, depth + 1);
      }
    };
    await visit(params.operations);
  }
  if (Buffer.byteLength(JSON.stringify(params)) > 60000)
    throw new Error('Scene request exceeds 60 KiB');
  const temporary = join(
    root,
    `.godot-mcp-${randomUUID()}${file.path.toLowerCase().endsWith('.scn') ? '.scn' : '.tscn'}`,
  );
  if (!inspecting) params.outputPath = temporary;
  try {
    const child = await runner.run(
      godot,
      [
        '--headless',
        '--path',
        root,
        '--script',
        join(scripts, 'scene_tools.gd'),
        '--',
        inspecting ? 'inspect' : 'modify',
        JSON.stringify(params),
      ],
      60000,
      signal,
    );
    requireSuccess(child);
    const line = child.output.find((item) => item.startsWith('GODOT_MCP_RESULT '));
    if (!line) throw new Error('Godot did not return a scene result');
    const result = JSON.parse(line.slice('GODOT_MCP_RESULT '.length));
    signal?.throwIfAborted();
    if (hash(await readFile(file.path)) !== sourceHash)
      throw new Error('Scene changed concurrently; changes were not saved');
    if (!inspecting && args.dryRun !== true) {
      await chmod(temporary, (await stat(file.path)).mode);
      // Check again immediately before the atomic replacement.
      signal?.throwIfAborted();
      if (hash(await readFile(file.path)) !== sourceHash)
        throw new Error('Scene changed concurrently; changes were not saved');
      await rename(temporary, file.path);
    }
    const data = {
      ...result,
      scenePath: file.resource,
      sourceHash,
      saved: !inspecting && args.dryRun !== true,
    };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } finally {
    if (!inspecting) await rm(temporary, { force: true });
  }
}
