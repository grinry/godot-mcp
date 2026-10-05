import { realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, sep } from 'node:path';

const readTools = new Set([
  'get_godot_version',
  'list_projects',
  'get_project_info',
  'list_project_files',
  'get_debug_output',
  'view_log',
  'get_uid',
  'get_class_info',
  'get_runtime_tree',
  'stop_project',
  'quit_godot',
  'close_session',
]);

export class ToolPolicy {
  constructor(
    private readonly roots = (process.env.GODOT_ALLOWED_ROOTS ?? '')
      .split(delimiter)
      .filter(Boolean),
    private readonly readOnly = process.env.GODOT_READ_ONLY === 'true',
  ) {}

  async check(name: string, args: Record<string, unknown>) {
    if (this.readOnly && !readTools.has(name))
      throw new Error(
        `GODOT_READ_ONLY blocks ${name}: it writes resources or executes project code`,
      );
    if (!this.roots.length) return;
    for (const key of ['projectPath', ...(name === 'list_projects' ? ['directory'] : [])]) {
      const value = args[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new Error(`${key} must be a path`);
      const path = await realpath(value);
      let allowed = false;
      for (const configured of this.roots) {
        const root = await realpath(configured);
        const local = relative(root, path);
        if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) allowed = true;
      }
      if (!allowed) throw new Error(`${key} is outside GODOT_ALLOWED_ROOTS`);
    }
  }
}

export function isReadTool(name: string) {
  return (
    readTools.has(name) &&
    name !== 'stop_project' &&
    name !== 'quit_godot' &&
    name !== 'close_session'
  );
}
