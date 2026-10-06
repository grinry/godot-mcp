import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { type OperationRunner, requireSuccess } from './operation-runner.js';
import { projectDirectory, projectFile, projectOutput, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const string = { type: 'string' };
const outputSchema = {
  type: 'object',
  properties: {
    resourcePath: string,
    className: string,
    sourceHash: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    saved: { type: 'boolean' },
    properties: { type: 'array', items: { type: 'object' } },
    truncated: { type: 'boolean' },
  },
  required: ['resourcePath', 'className', 'sourceHash', 'saved'],
};
export const resourceTools: ToolSpecification[] = [
  ...(['get_resource_info', 'create_resource', 'set_resource_properties'] as const).map(
    (name): ToolSpecification => ({
      name,
      access: 'execute',
      session: 'none',
      outputSchema,
      description:
        name === 'get_resource_info'
          ? 'Inspect bounded stored properties of a .tres/.res resource. Loading resources and getters may execute project code.'
          : name === 'create_resource'
            ? 'Create a built-in Resource as .tres/.res without overwriting existing files. Parent directory must exist. Supports typed properties and dryRun.'
            : 'Set stored properties of a .tres/.res resource and save atomically, preserving its UID and script. Supports dryRun and expectedHash. Executes setters.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: string,
          resourcePath: string,
          ...(name === 'get_resource_info'
            ? {
                maxProperties: { type: 'integer', minimum: 1, maximum: 200 },
              }
            : {
                properties: { type: 'object' },
                dryRun: { type: 'boolean' },
                ...(name === 'create_resource' ? { className: string } : { expectedHash: string }),
              }),
        },
        required: [
          'projectPath',
          'resourcePath',
          ...(name === 'create_resource'
            ? ['className']
            : name === 'set_resource_properties'
              ? ['properties']
              : []),
        ],
      },
    }),
  ),
];

/** Constrain every typed resource reference, including nested request values. */
export async function validateResourceValues(
  root: string,
  value: unknown,
  depth = 0,
): Promise<void> {
  if (depth > 16) throw new Error('Property nesting exceeds limit');
  if (value && typeof value === 'object') {
    if ('type' in value && value.type === 'Resource' && 'path' in value)
      await projectFile(root, value.path);
    for (const child of Object.values(value)) await validateResourceValues(root, child, depth + 1);
  }
}

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const queues = new Map<string, Promise<void>>();

/** Serialize writes to a resource across all sessions, including create-if-absent. */
export async function handleResourceTool(
  name: string,
  args: Record<string, unknown>,
  godot: string,
  scripts: string,
  runner: OperationRunner,
  signal?: AbortSignal,
) {
  const root = await projectRoot(args.projectPath);
  const create = name === 'create_resource';
  const file = create
    ? await projectOutput(root, args.resourcePath, ['.tres', '.res'])
    : await projectFile(root, args.resourcePath, ['.tres', '.res']);
  // Existing directories are required; previews must not create filesystem structure.
  const parent = await projectDirectory(root, relative(root, dirname(file.path)) || '.');
  const target = join(parent.path, file.path.slice(dirname(file.path).length + 1));
  const previous = queues.get(target) ?? Promise.resolve();
  const pending = previous.then(() =>
    runResourceTool(name, args, root, { ...file, path: target }, godot, scripts, runner, signal),
  );
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  queues.set(target, settled);
  try {
    return await pending;
  } finally {
    if (queues.get(target) === settled) queues.delete(target);
  }
}

async function runResourceTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  file: { path: string; resource: string },
  godot: string,
  scripts: string,
  runner: OperationRunner,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const inspecting = name === 'get_resource_info';
  const create = name === 'create_resource';
  let original: Buffer | undefined;
  try {
    original = await readFile(file.path);
  } catch (error) {
    if (!(create && error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (create && original) throw new Error('Resource already exists; use set_resource_properties');
  const sourceHash = original ? hash(original) : null;
  const params: Record<string, unknown> = { resourcePath: file.resource };
  if (inspecting) {
    const count = args.maxProperties ?? 50;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 200)
      throw new Error('maxProperties must be between 1 and 200');
    params.maxProperties = count;
  } else {
    if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')
      throw new Error('dryRun must be boolean');
    if (args.expectedHash !== undefined && args.expectedHash !== sourceHash)
      throw new Error('Resource changed since preview; inspect it again');
    const properties = args.properties ?? (create ? {} : undefined);
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      Object.keys(properties).length > 100 ||
      (!create && Object.keys(properties).length === 0)
    )
      throw new Error('properties must be a dictionary with up to 100 entries');
    params.properties = properties;
    if (create) {
      if (
        typeof args.className !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(args.className)
      )
        throw new Error('className must be a built-in Resource class');
      params.className = args.className;
    }
    await validateResourceValues(root, properties);
  }
  if (Buffer.byteLength(JSON.stringify(params)) > 60000)
    throw new Error('Resource request exceeds 60 KiB');
  const extension = file.path.toLowerCase().endsWith('.tres') ? '.tres' : '.res';
  const temporary = join(root, `.godot-mcp-${randomUUID()}${extension}`);
  if (!inspecting) params.outputPath = temporary;
  try {
    const child = await runner.run(
      godot,
      [
        '--headless',
        '--path',
        root,
        '--script',
        join(scripts, 'resource_tools.gd'),
        '--',
        name,
        JSON.stringify(params),
      ],
      60000,
      signal,
    );
    requireSuccess(child);
    const line = child.output.find((item) => item.startsWith('GODOT_MCP_RESULT '));
    if (!line) throw new Error('Godot did not return a resource result');
    const result = JSON.parse(line.slice('GODOT_MCP_RESULT '.length));
    signal?.throwIfAborted();
    if (!create && hash(await readFile(file.path)) !== sourceHash)
      throw new Error('Resource changed concurrently; changes were not saved');
    if (!inspecting && args.dryRun !== true) {
      // Repeat confinement immediately before saving; never follow a newly escaping symlink.
      await projectOutput(root, file.resource, ['.tres', '.res']);
      signal?.throwIfAborted();
      if (create) {
        // Hard-link publication is atomic and refuses an independently created target.
        await link(temporary, file.path);
      } else {
        await chmod(temporary, (await stat(file.path)).mode);
        if (hash(await readFile(file.path)) !== sourceHash)
          throw new Error('Resource changed concurrently; changes were not saved');
        await rename(temporary, file.path);
      }
    }
    const data = {
      ...result,
      resourcePath: file.resource,
      sourceHash,
      saved: !inspecting && args.dryRun !== true,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      structuredContent: data,
    };
  } finally {
    if (!inspecting)
      await Promise.all([rm(temporary, { force: true }), rm(`${temporary}.uid`, { force: true })]);
  }
}
