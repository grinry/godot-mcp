import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { type OperationRunner, requireSuccess } from './operation-runner.js';
import { projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const string = { type: 'string' };
const sceneProperties = { projectPath: string, scenePath: string };
export const authoringTools: ToolSpecification[] = [
  {
    name: 'attach_script',
    access: 'execute',
    session: 'none',
    description:
      'Attach a compatible GDScript or C# script to a scene node. Executes project constructors; refuses unavailable scripts before saving. C# requires Godot .NET and a built assembly.',
    inputSchema: {
      type: 'object',
      properties: { ...sceneProperties, nodePath: string, scriptPath: string },
      required: ['projectPath', 'scenePath', 'nodePath', 'scriptPath'],
    },
  },
  {
    name: 'set_main_scene',
    access: 'execute',
    session: 'none',
    description: 'Set the configured project main scene, preserving other settings and comments.',
    inputSchema: {
      type: 'object',
      properties: sceneProperties,
      required: ['projectPath', 'scenePath'],
    },
  },
  {
    name: 'set_node_reference',
    access: 'execute',
    session: 'none',
    description:
      'Bind an exported Node or NodePath script property to a compatible node in the same scene. Executes project constructors; preserves script references.',
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneProperties,
        nodePath: string,
        property: string,
        targetNodePath: string,
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'property', 'targetNodePath'],
    },
  },
  {
    name: 'get_class_info',
    access: 'read',
    session: 'none',
    description:
      'Read properties, methods, signals or enums of a built-in class from the installed Godot version. Reflection metadata, not prose documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        className: string,
        section: { type: 'string', enum: ['properties', 'methods', 'signals', 'enums'] },
        filter: string,
        includeInherited: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['className'],
    },
  },
];

export function nodePath(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.includes(':') ||
    value.split('/').includes('..')
  )
    throw new Error('nodePath must identify a node inside the scene');
  return value;
}

export async function setMainScene(root: string, resource: string) {
  const file = await projectFile(root, 'project.godot');
  const original = await readFile(file.path, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const applications = lines.flatMap((line, index) =>
    /^\s*\[application\]\s*$/.test(line) ? [index] : [],
  );
  if (applications.length > 1) throw new Error('Duplicate application sections');
  const setting = `run/main_scene=${JSON.stringify(resource)}`;
  if (!applications.length) lines.push('[application]', setting, '');
  else {
    const start = applications[0] + 1;
    let end = start;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const existing = lines.flatMap((line, index) =>
      index >= start && index < end && /^\s*run\/main_scene\s*=/.test(line) ? [index] : [],
    );
    if (existing.length > 1) throw new Error('Duplicate main-scene settings');
    if (existing.length) lines[existing[0]] = setting;
    else lines.splice(start, 0, setting);
  }
  const temporary = `${file.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, lines.join(newline), {
      flag: 'wx',
      mode: (await stat(file.path)).mode,
    });
    if ((await readFile(file.path, 'utf8')) !== original)
      throw new Error('Project settings changed concurrently');
    await rename(temporary, file.path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function handleAuthoringTool(
  name: string,
  args: Record<string, unknown>,
  godot: string,
  scripts: string,
  runner: OperationRunner,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  let command: string[];
  let reflection = false;
  let params: Record<string, unknown> = args;
  if (name === 'get_class_info') {
    reflection = true;
    if (
      typeof args.className !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(args.className)
    )
      throw new Error('className must be a built-in class name');
    if (
      args.section !== undefined &&
      !['properties', 'methods', 'signals', 'enums'].includes(String(args.section))
    )
      throw new Error('Invalid section');
    if (args.filter !== undefined && (typeof args.filter !== 'string' || args.filter.length > 128))
      throw new Error('Invalid filter');
    if (args.includeInherited !== undefined && typeof args.includeInherited !== 'boolean')
      throw new Error('includeInherited must be boolean');
    const limit = args.limit ?? 100;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('limit must be between 1 and 500');
    params = { ...args, limit };
    command = [
      '--headless',
      '--script',
      join(scripts, 'authoring.gd'),
      '--',
      name,
      JSON.stringify(params),
    ];
  } else {
    const root = await projectRoot(args.projectPath);
    const scene = await projectFile(root, args.scenePath, ['.tscn', '.scn']);
    if (name === 'set_main_scene') {
      signal?.throwIfAborted();
      await setMainScene(root, scene.resource);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ success: true, scenePath: scene.resource }) },
        ],
      };
    }
    params = { scenePath: scene.resource, nodePath: nodePath(args.nodePath) };
    if (name === 'attach_script')
      params.scriptPath = (await projectFile(root, args.scriptPath, ['.gd', '.cs'])).resource;
    else if (name === 'set_node_reference') {
      if (
        typeof args.property !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(args.property)
      )
        throw new Error('property must be an exported property name');
      params.property = args.property;
      params.targetNodePath = nodePath(args.targetNodePath);
    } else throw new Error('Unknown authoring tool');
    command = [
      '--headless',
      '--path',
      root,
      '--script',
      join(scripts, 'authoring.gd'),
      '--',
      name,
      JSON.stringify(params),
    ];
  }
  // Reflection must not discover a project/autoload from the server's working directory.
  const isolated = reflection ? await mkdtemp(join(tmpdir(), 'godot-mcp-classdb-')) : undefined;
  try {
    if (isolated) command.splice(1, 0, '--path', isolated);
    const child = await runner.run(godot, command, 60000, signal);
    requireSuccess(child);
    const result = child.output.find((line) => line.startsWith('GODOT_MCP_RESULT '));
    if (!result) throw new Error('Godot did not return an authoring result');
    return { content: [{ type: 'text', text: result.slice('GODOT_MCP_RESULT '.length) }] };
  } finally {
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
}
