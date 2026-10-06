import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { projectFile } from './project-paths.js';

interface Entry {
  section: string;
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
  end: number;
}
interface Section {
  name: string;
  insert: number;
}
export interface ConfigDocument {
  entries: Entry[];
  sections: Section[];
  newline: string;
}

/** Locate complete INI Variant assignments without rewriting surrounding text. */
export function parseProjectConfig(text: string): ConfigDocument {
  const entries: Entry[] = [];
  const sections: Section[] = [];
  let section = '';
  let cursor = text.startsWith('\uFEFF') ? 1 : 0;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  while (cursor < text.length) {
    const next = text.indexOf('\n', cursor);
    const lineEnd = next === -1 ? text.length : next + 1;
    const line = text.slice(cursor, lineEnd).replace(/\r?\n$/, '');
    const header = line.match(/^\s*\[([^\]\r\n]+)\]\s*(?:;.*)?$/);
    if (header) {
      section = header[1];
      if (sections.some((entry) => entry.name === section))
        throw new Error('Duplicate configuration section');
      sections.push({ name: section, insert: lineEnd });
      cursor = lineEnd;
      continue;
    }
    if (!line.trim() || /^\s*;/.test(line)) {
      cursor = lineEnd;
      continue;
    }
    const assignment = line.match(/^[ \t]*([^=;\r\n]+?)\s*=/);
    if (!assignment) throw new Error('Unsupported configuration syntax; file was not changed');
    const key = assignment[1].trim();
    if (entries.some((entry) => entry.section === section && entry.key === key))
      throw new Error('Duplicate configuration key');
    let valueStart = cursor + assignment[0].length;
    while (text[valueStart] === ' ' || text[valueStart] === '\t') valueStart++;
    let index = valueStart;
    let quoted = false;
    let escaped = false;
    let comment = false;
    const stack: string[] = [];
    let valueEnd = valueStart;
    for (; index < text.length; index++) {
      const character = text[index];
      if (comment) {
        if (character !== '\n') continue;
        comment = false;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        valueEnd = index + 1;
        continue;
      }
      if (character === '\n' && stack.length === 0) break;
      if (character === ';') {
        comment = true;
        continue;
      }
      if (character === '"') quoted = true;
      else if ('([{'.includes(character)) stack.push(character);
      else if (')]}'.includes(character)) {
        const opening = stack.pop();
        if (!opening || '([{'.indexOf(opening) !== ')]}'.indexOf(character))
          throw new Error('Unbalanced configuration value');
      }
      if (!/\s/.test(character)) valueEnd = index + 1;
    }
    if (quoted || stack.length || valueEnd === valueStart)
      throw new Error('Incomplete configuration value');
    const end = index < text.length ? index + 1 : index;
    entries.push({ section, key, start: cursor, valueStart, valueEnd, end });
    cursor = end;
  }
  return { entries, sections, newline };
}

/** Replace only a targeted value, or remove its assignment; preserve all other bytes. */
export function patchProjectConfig(
  text: string,
  section: string,
  key: string,
  expression: string | null,
) {
  const document = parseProjectConfig(text);
  const entry = document.entries.find((item) => item.section === section && item.key === key);
  if (entry) {
    if (expression === null) return text.slice(0, entry.start) + text.slice(entry.end);
    return (
      text.slice(0, entry.valueStart) +
      expression.replace(/\r?\n/g, document.newline) +
      text.slice(entry.valueEnd)
    );
  }
  if (expression === null) throw new Error('Configuration entry is not stored in project.godot');
  const header = document.sections.find((item) => item.name === section);
  const assignment = `${key}=${expression.replace(/\r?\n/g, document.newline)}${document.newline}`;
  if (header) {
    // Append after existing entries, especially autoloads whose order matters.
    const insertion =
      document.entries.filter((item) => item.section === section).at(-1)?.end ?? header.insert;
    const prefix = text.slice(0, insertion);
    return (
      prefix + (prefix.endsWith('\n') ? '' : document.newline) + assignment + text.slice(insertion)
    );
  }
  return (
    text +
    (text.endsWith('\n') ? '' : document.newline) +
    `${document.newline}[${section}]${document.newline}${assignment}`
  );
}

export interface ProjectConfigSnapshot {
  file: string;
  original: string;
  sourceHash: string;
  document: ConfigDocument;
}
const queues = new Map<string, Promise<void>>();

/** Share serialization with every project.godot writer, including set_main_scene. */
export async function withProjectConfig<T>(
  root: string,
  operation: (snapshot: ProjectConfigSnapshot) => Promise<T>,
) {
  const file = (await projectFile(root, 'project.godot')).path;
  const previous = queues.get(file) ?? Promise.resolve();
  const pending = previous.then(async () => {
    if ((await stat(file)).size > 1024 * 1024) throw new Error('project.godot exceeds 1 MiB');
    const bytes = await readFile(file);
    const original = bytes.toString('utf8');
    if (!Buffer.from(original, 'utf8').equals(bytes))
      throw new Error('project.godot is not valid UTF-8');
    return operation({
      file,
      original,
      sourceHash: createHash('sha256').update(original).digest('hex'),
      document: parseProjectConfig(original),
    });
  });
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  queues.set(file, settled);
  try {
    return await pending;
  } finally {
    if (queues.get(file) === settled) queues.delete(file);
  }
}

/** Publish a checked configuration while retaining mode and rejecting stale reads. */
export async function saveProjectConfig(
  snapshot: ProjectConfigSnapshot,
  text: string,
  dryRun: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if ((await readFile(snapshot.file, 'utf8')) !== snapshot.original)
    throw new Error('Project settings changed concurrently; nothing saved');
  if (dryRun) return;
  const temporary = `${snapshot.file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: (await stat(snapshot.file)).mode });
    signal?.throwIfAborted();
    if ((await readFile(snapshot.file, 'utf8')) !== snapshot.original)
      throw new Error('Project settings changed concurrently; nothing saved');
    await rename(temporary, snapshot.file);
  } finally {
    await rm(temporary, { force: true });
  }
}
