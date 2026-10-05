import { opendir } from 'node:fs/promises';
import { extname, join } from 'node:path';

export type ProjectFileType = 'scene' | 'script' | 'resource' | 'all';

export interface ListProjectFilesOptions {
  pattern?: string;
  type?: ProjectFileType;
  limit?: number;
  signal?: AbortSignal;
}

export interface ProjectFilesResult {
  scenes: string[];
  scripts: string[];
  resources: string[];
  total: number;
  truncated: boolean;
}

type ProjectFileCategory = 'scenes' | 'scripts' | 'resources';

const SCENE_EXTENSIONS = new Set(['.tscn', '.scn']);
const SCRIPT_EXTENSIONS = new Set(['.gd', '.gdscript', '.cs']);
const RESOURCE_EXTENSIONS = new Set(['.tres', '.res', '.gdshader', '.shader', '.gdshaderinc']);

function normalizePattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');

  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || segments.includes('..')) {
    throw new Error('Pattern must be relative to the project and cannot contain ".."');
  }

  return normalized;
}

function globToRegExp(pattern: string): RegExp {
  let expression = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else if ('\\^$+?.()|{}[]'.includes(character)) {
      expression += `\\${character}`;
    } else {
      expression += character;
    }
  }

  return new RegExp(`${expression}$`);
}

function getFileCategory(filename: string): ProjectFileCategory | null {
  const extension = extname(filename).toLowerCase();

  if (SCENE_EXTENSIONS.has(extension)) {
    return 'scenes';
  }

  if (SCRIPT_EXTENSIONS.has(extension)) {
    return 'scripts';
  }

  if (RESOURCE_EXTENSIONS.has(extension)) {
    return 'resources';
  }

  return null;
}

export async function listProjectFiles(
  projectPath: string,
  options: ListProjectFilesOptions = {},
): Promise<ProjectFilesResult> {
  const result: ProjectFilesResult = {
    scenes: [],
    scripts: [],
    resources: [],
    total: 0,
    truncated: false,
  };
  const selectedType = options.type ?? 'all';
  if (!['all', 'scene', 'script', 'resource'].includes(selectedType))
    throw new Error('Invalid file type');
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('limit must be between 1 and 10000');
  if (options.pattern && (typeof options.pattern !== 'string' || options.pattern.length > 256))
    throw new Error('Invalid pattern');
  let visited = 0;
  const normalizedPattern = options.pattern ? normalizePattern(options.pattern) : undefined;
  const patternMatcher = normalizedPattern ? globToRegExp(normalizedPattern) : undefined;

  const scanDirectory = async (
    directoryPath: string,
    relativeDirectory = '',
    depth = 0,
  ): Promise<void> => {
    options.signal?.throwIfAborted();
    if (depth > 64) {
      result.truncated = true;
      return;
    }
    const entries = await opendir(directoryPath);

    for await (const entry of entries) {
      options.signal?.throwIfAborted();
      if (++visited > 50000 || result.total >= limit) {
        result.truncated = true;
        return;
      }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await scanDirectory(join(directoryPath, entry.name), relativePath, depth + 1);
        if (result.truncated && (visited > 50000 || result.total >= limit)) return;
        continue;
      }

      if (!entry.isFile() || (patternMatcher && !patternMatcher.test(relativePath))) {
        continue;
      }

      const category = getFileCategory(entry.name);
      if (!category) {
        continue;
      }

      if (selectedType !== 'all' && `${selectedType}s` !== category) {
        continue;
      }

      result[category].push(relativePath);
      result.total += 1;
    }
  };

  await scanDirectory(projectPath);
  result.scenes.sort();
  result.scripts.sort();
  result.resources.sort();
  return result;
}
