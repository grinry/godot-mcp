import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { pluginList, pluginSetting } from './editor-plugin-config.js';
import { parseProjectConfig, saveProjectConfig, withProjectConfig } from './project-config.js';
import { projectDirectory, projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const string = { type: 'string' };
export const editorPluginTools: ToolSpecification[] = [
  'get_editor_plugins',
  'enable_editor_plugin',
  'disable_editor_plugin',
].map((name) => ({
  name,
  description:
    name === 'get_editor_plugins'
      ? 'List installed editor plugins and their saved enablement without executing Godot. Does not report the live editor checkbox state.'
      : `${name === 'enable_editor_plugin' ? 'Enable' : 'Disable'} an editor plugin in project.godot, preserving other plugins and comments. Supports dryRun and expectedHash. Save and reopen an already-open editor to apply; this does not claim live activation.`,
  access: name === 'get_editor_plugins' ? 'read' : 'execute',
  session: 'none',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: string,
      ...(name === 'get_editor_plugins'
        ? {}
        : {
            pluginPath: {
              type: 'string',
              description: 'Project-relative or res://addons/.../plugin.cfg path',
            },
            dryRun: { type: 'boolean' },
            expectedHash: string,
          }),
    },
    required: name === 'get_editor_plugins' ? ['projectPath'] : ['projectPath', 'pluginPath'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      sourceHash: string,
      configuredOnly: { type: 'boolean' },
      ...(name === 'get_editor_plugins'
        ? { plugins: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' } }
        : {
            pluginPath: string,
            configuredEnabled: { type: 'boolean' },
            changed: { type: 'boolean' },
            saved: { type: 'boolean' },
            activation: string,
            nextAction: string,
          }),
    },
    required: ['sourceHash', 'configuredOnly'],
  },
}));

function normalizedPlugin(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    !/^(res:\/\/)?addons\/(?:[^/:\0]+\/)+plugin\.cfg$/.test(value) ||
    value.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error('pluginPath must be addons/.../plugin.cfg inside the project');
  return value.startsWith('res://') ? value : `res://${value}`;
}
async function pluginMetadata(root: string, resource: string) {
  const file = await projectFile(root, resource, ['.cfg']);
  if ((await stat(file.path)).size > 65536) throw new Error('Plugin configuration exceeds 64 KiB');
  const source = await readFile(file.path, 'utf8');
  const document = parseProjectConfig(source);
  const fields: Record<string, string> = {};
  for (const key of ['name', 'description', 'author', 'version', 'script']) {
    const entry = document.entries.find((item) => item.section === 'plugin' && item.key === key);
    if (!entry) throw new Error(`Plugin configuration missing ${key}`);
    const value: unknown = JSON.parse(source.slice(entry.valueStart, entry.valueEnd));
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid plugin ${key}`);
    fields[key] = value;
  }
  if (!fields.script || fields.script.startsWith('/') || fields.script.split('/').includes('..'))
    throw new Error('Invalid plugin script path');
  const script = fields.script.startsWith('res://')
    ? fields.script
    : `${file.resource.slice(0, -'plugin.cfg'.length)}${fields.script}`;
  await projectFile(root, script, ['.gd', '.cs']);
  return { pluginPath: file.resource, ...fields, scriptPath: script };
}
export async function handleEditorPluginTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const root = await projectRoot(args.projectPath);
  return withProjectConfig(root, async (snapshot) => {
    signal?.throwIfAborted();
    const enabled = pluginList(snapshot.original, snapshot.document.entries);
    let result: Record<string, unknown>;
    if (name === 'get_editor_plugins') {
      const plugins: Record<string, unknown>[] = [];
      const paths = new Set(enabled);
      const addons = await projectDirectory(root, 'addons').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      const queue = addons ? [addons.path] : [];
      let visited = 0;
      while (queue.length && visited < 1000 && paths.size < 200) {
        signal?.throwIfAborted();
        const directory = queue.shift();
        if (!directory) break;
        const items = await readdir(directory, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          },
        );
        visited++;
        for (const item of items) {
          if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
          if (item.isDirectory()) queue.push(join(directory, item.name));
          else if (item.name === 'plugin.cfg' && item.isFile())
            paths.add(
              `res://${join(directory, item.name)
                .slice(root.length + 1)
                .replaceAll('\\', '/')}`,
            );
        }
      }
      for (const path of [...paths].sort().slice(0, 200)) {
        try {
          plugins.push({
            ...(await pluginMetadata(root, normalizedPlugin(path))),
            configuredEnabled: enabled.includes(path),
          });
        } catch (error) {
          plugins.push({
            pluginPath: path,
            configuredEnabled: enabled.includes(path),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      result = {
        plugins,
        truncated: queue.length > 0 || paths.size > 200,
        configuredOnly: true,
        sourceHash: snapshot.sourceHash,
      };
    } else {
      if (name !== 'enable_editor_plugin' && name !== 'disable_editor_plugin')
        throw new Error('Unknown editor plugin tool');
      if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')
        throw new Error('dryRun must be boolean');
      if (args.expectedHash !== undefined && args.expectedHash !== snapshot.sourceHash)
        throw new Error('Project settings changed since preview');
      const pluginPath = normalizedPlugin(args.pluginPath);
      const enable = name === 'enable_editor_plugin';
      if (enable) await pluginMetadata(root, pluginPath);
      const updated = pluginSetting(
        snapshot.original,
        snapshot.document.entries,
        pluginPath,
        enable,
      );
      await saveProjectConfig(snapshot, updated, args.dryRun === true, signal);
      result = {
        pluginPath,
        configuredEnabled: enable,
        configuredOnly: true,
        changed: updated !== snapshot.original,
        saved: args.dryRun !== true,
        sourceHash: snapshot.sourceHash,
        activation: 'editor_reload_required',
        nextAction:
          'Save and reopen an already-open editor. This tool changes saved configuration, not the live editor state.',
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
}
