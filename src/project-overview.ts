import { readFile, stat } from 'node:fs/promises';
import { listProjectFiles } from './project-files.js';
import { projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

export const overviewTool: ToolSpecification = {
  name: 'get_project_overview',
  access: 'read',
  session: 'none',
  description:
    'Read a bounded project overview without executing Godot: main scene, autoloads, input actions, enabled addons, custom GDScript classes and text scene/resource dependencies. Binary resources and UID resolution are explicitly incomplete.',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['projectPath'],
  },
};

/** Preserve Godot expressions rather than pretending they are JSON. */
export function configEntries(source: string) {
  const result: { section: string; key: string; expression: string }[] = [];
  let section = '';
  let current: (typeof result)[number] | undefined;
  for (const line of source.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    const setting = /^\s*([^;#\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (header) {
      section = header[1];
      current = undefined;
    } else if (setting) {
      current = { section, key: setting[1], expression: setting[2] };
      result.push(current);
    } else if (current && line.trim() && !/^\s*[;#]/.test(line)) current.expression += `\n${line}`;
  }
  return result;
}

export async function projectOverview(args: Record<string, unknown>, signal?: AbortSignal) {
  const root = await projectRoot(args.projectPath);
  const limit = args.limit ?? 200;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('limit must be between 1 and 500');
  let bytes = 0;
  let truncated = false;
  const read = async (path: string) => {
    signal?.throwIfAborted();
    const file = await projectFile(root, path);
    const size = (await stat(file.path)).size;
    if (size > 256 * 1024 || bytes + size > 4 * 1024 * 1024) {
      truncated = true;
      return null;
    }
    bytes += size;
    return readFile(file.path, 'utf8');
  };
  const project = await read('project.godot');
  if (project === null) throw new Error('project.godot exceeds overview size limits');
  const entries = configEntries(project);
  const selection = (section: string) => {
    const all = entries.filter((entry) => entry.section === section);
    if (all.length > limit) truncated = true;
    return all.slice(0, limit).map(({ key, expression }) => ({ name: key, expression }));
  };
  const files = await listProjectFiles(root, { limit, signal });
  truncated ||= files.truncated;
  const classes: { name: string; baseClass: string | null; path: string }[] = [];
  const dependencies: { path: string; references: string[]; incomplete: boolean }[] = [];
  for (const path of files.scripts.filter(
    (path) => path.endsWith('.gd') || path.endsWith('.gdscript'),
  )) {
    const source = await read(path);
    if (source === null) continue;
    const name = /^\s*class_name\s+([A-Za-z_]\w*)/m.exec(source)?.[1];
    if (name)
      classes.push({
        name,
        baseClass: /^\s*extends\s+([^\n#]+)/m.exec(source)?.[1].trim() ?? null,
        path: `res://${path}`,
      });
  }
  for (const path of [...files.scenes, ...files.resources]) {
    if (!path.endsWith('.tscn') && !path.endsWith('.tres')) {
      dependencies.push({ path: `res://${path}`, references: [], incomplete: true });
      continue;
    }
    const source = await read(path);
    if (source === null) {
      dependencies.push({ path: `res://${path}`, references: [], incomplete: true });
      continue;
    }
    const references = [
      ...new Set(
        [...source.matchAll(/\b(?:path|uid)="((?:res|uid):\/\/[^"\n]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    dependencies.push({
      path: `res://${path}`,
      references: references.slice(0, 200),
      incomplete: references.length > 200,
    });
    if (references.length > 200) truncated = true;
  }
  const main =
    entries.find((entry) => entry.section === 'application' && entry.key === 'run/main_scene')
      ?.expression ?? null;
  return {
    projectPath: root,
    mainScene: main,
    autoloads: selection('autoload'),
    inputActions: selection('input'),
    enabledAddons: selection('editor_plugins'),
    customClasses: classes,
    dependencies,
    files,
    truncated,
    limitations: [
      'Settings are Godot expressions, not evaluated values.',
      'Only discovered text scenes/resources are scanned; binary resources and UID targets are not resolved.',
      'Script classes are declarations found in source; addons and C# classes may have additional metadata.',
    ],
  };
}
