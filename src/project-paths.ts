import { lstat, realpath, stat } from 'node:fs/promises';
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

/** Resolve a prospective resource without allowing existing parent symlinks to escape. */
export async function projectOutput(root: string, value: unknown, extensions?: string[]) {
  root = await realpath(root);
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Output path is required');
  const stripped = value.replace(/^res:\/\//, '').replace(/\\/g, '/');
  if (isAbsolute(stripped) || stripped.includes(':') || stripped.split('/').includes('..'))
    throw new Error('Output path must stay inside the project');
  const path = resolve(root, stripped);
  if (extensions && !extensions.some((extension) => path.toLowerCase().endsWith(extension)))
    throw new Error('Unexpected output resource type');
  let ancestor = path;
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      const local = relative(root, actual);
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw new Error('Output symlink escapes project');
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      // ENOENT may describe a dangling symlink, which a writer would follow.
      const entry = await lstat(ancestor).catch((failure: unknown) => {
        if (failure instanceof Error && 'code' in failure && failure.code === 'ENOENT')
          return undefined;
        throw failure;
      });
      if (entry?.isSymbolicLink()) throw new Error('Dangling output symlink is not allowed');
      const parent = resolve(ancestor, '..');
      if (parent === ancestor) throw new Error('Cannot resolve output parent');
      ancestor = parent;
    }
  }
  return { path, resource: `res://${relative(root, path).split(sep).join('/')}` };
}
