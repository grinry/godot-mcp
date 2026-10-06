import { realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, sep } from 'node:path';
import { toolSpecifications } from './tool-specifications.js';
import type { ToolAccess } from './tool-types.js';

export class ToolPolicy {
  constructor(
    private readonly roots = (process.env.GODOT_ALLOWED_ROOTS ?? '')
      .split(delimiter)
      .filter(Boolean),
    private readonly readOnly = process.env.GODOT_READ_ONLY === 'true',
  ) {}

  async check(name: string, args: Record<string, unknown>, access?: ToolAccess) {
    access ??= toolSpecifications.find((tool) => tool.name === name)?.access;
    if (this.readOnly && (access === undefined || access === 'execute'))
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
  return toolSpecifications.find((tool) => tool.name === name)?.access === 'read';
}
