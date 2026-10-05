import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function projectRoot(value: unknown) {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('projectPath is required');
  const root = await realpath(resolve(value));
  if (!(await stat(join(root, 'project.godot'))).isFile()) throw new Error('Not a Godot project');
  return root;
}

async function projectResource(root: string, value: unknown) {
  root = await realpath(root);
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Resource path is required');
  const stripped = value.replace(/^res:\/\//, '').replace(/\\/g, '/');
  if (isAbsolute(stripped) || /^[A-Za-z]:/.test(stripped) || stripped.split('/').includes('..')) {
    throw new Error('Resource path must stay inside the project');
  }
  const path = await realpath(join(root, stripped));
  const local = relative(root, path);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error('Resource symlink escapes project');
  return { path, resource: `res://${local.split(sep).join('/')}` };
}

export async function projectFile(root: string, value: unknown, extensions?: string[]) {
  const result = await projectResource(root, value);
  if (!(await stat(result.path)).isFile()) throw new Error('Resource is not a file');
  if (extensions && !extensions.some((ext) => result.path.toLowerCase().endsWith(ext)))
    throw new Error('Unexpected resource type');
  return result;
}

export async function projectDirectory(root: string, value: unknown) {
  const result = await projectResource(root, value);
  if (!(await stat(result.path)).isDirectory()) throw new Error('Resource is not a directory');
  return result;
}
