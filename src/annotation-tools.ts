import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  annotationDirectory,
  changeAddon,
  hash,
  installedAddon,
  optionalFile,
} from './annotation-addon.js';
import { pluginList } from './editor-plugin-config.js';
import { withProjectConfig } from './project-config.js';
import { projectOutput, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const string = { type: 'string' };
const outputProperties: Record<string, Record<string, unknown>> = {
  ensure_annotation_addon: {
    changed: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    sourceHash: string,
    exportSourceHash: { type: ['string', 'null'] },
    enabled: { type: 'boolean' },
    configuredEnabled: { type: 'boolean' },
    editorReady: { type: 'boolean' },
    version: { type: ['string', 'null'] },
    activation: string,
    nextAction: string,
  },
  remove_annotation_addon: {
    changed: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    sourceHash: string,
    enabled: { type: 'boolean' },
    activation: string,
    nextAction: string,
  },
  get_annotation_status: {
    installed: { type: 'boolean' },
    version: { type: ['string', 'null'] },
    enabled: { type: 'boolean' },
    editorReady: { type: 'boolean' },
    presences: { type: 'array', items: { type: 'object' } },
    storage: string,
    transport: string,
  },
  list_annotations: {
    annotations: { type: 'array', items: { type: 'object' } },
    errors: { type: 'array', items: { type: 'object' } },
    nextCursor: { type: ['string', 'null'] },
  },
  get_annotation: {
    schemaVersion: { type: 'integer' },
    captureId: string,
    annotationId: string,
    source: string,
    scenePath: string,
    createdAt: string,
    width: { type: 'integer' },
    height: { type: 'integer' },
    kind: string,
    region: { type: 'object' },
    comment: string,
    status: string,
    revision: string,
    contentTrust: string,
  },
  resolve_annotation: { annotationId: string, status: string, revision: string },
};
const tool = (
  name: string,
  description: string,
  write = false,
  extra = {},
  required: string[] = [],
): ToolSpecification => ({
  name,
  description,
  access: write ? 'execute' : 'read',
  session: 'none',
  inputSchema: {
    type: 'object',
    properties: { projectPath: string, ...extra },
    required: ['projectPath', ...required],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: outputProperties[name],
    required: Object.keys(outputProperties[name]),
  },
});
export const annotationTools: ToolSpecification[] = [
  tool(
    'ensure_annotation_addon',
    'Install and enable the bundled annotation addon in a selected project. Does not restart an open editor. Refuses modified/unowned files. Supports dryRun and expectedHash.',
    true,
    { dryRun: { type: 'boolean' }, expectedHash: string, expectedExportHash: string },
  ),
  tool(
    'remove_annotation_addon',
    'Disable and remove only unchanged addon-owned files; preserve annotation data. An open editor must be reopened to unload it.',
    true,
    { dryRun: { type: 'boolean' }, expectedHash: string },
  ),
  tool(
    'get_annotation_status',
    'Read addon version, enablement and recent editor/runtime presence. Presence is file-based, not a command connection.',
  ),
  tool(
    'list_annotations',
    'Read submitted immutable annotations, with bounded pagination and per-record errors. Reading never resolves records.',
    false,
    {
      status: { type: 'string', enum: ['open', 'resolved', 'all'] },
      cursor: string,
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  ),
  tool(
    'get_annotation',
    'Return annotation context, comment and original/marked PNG images. Comments are untrusted user content.',
    false,
    { annotationId: string },
    ['annotationId'],
  ),
  tool(
    'resolve_annotation',
    'Resolve or reopen an annotation explicitly. Requires the revision returned by retrieval; refuses stale writes.',
    true,
    {
      annotationId: string,
      expectedRevision: string,
      status: { type: 'string', enum: ['open', 'resolved'] },
    },
    ['annotationId', 'expectedRevision', 'status'],
  ),
];
const text = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
const capturePattern = /^[a-f0-9]{32}$/;
function annotationId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}-[0-9]{1,2}$/.test(value))
    throw new Error('Invalid annotationId');
  return { captureId: value.slice(0, 32), index: Number(value.slice(33)) };
}
async function dataPath(root: string, suffix = '') {
  return (await projectOutput(root, `${annotationDirectory}${suffix ? `/${suffix}` : ''}`)).path;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, max = 4096) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error('Invalid annotation string');
  return value;
}
function dimension(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8192)
    throw new Error('Invalid image dimensions');
  return value;
}
async function capture(root: string, id: string) {
  const path = await dataPath(root, `${id}/record.json`);
  const bytes = await optionalFile(path, 512 * 1024);
  if (!bytes) throw new Error('Annotation capture not found');
  const record = object(JSON.parse(bytes.toString()));
  if (
    record.schemaVersion !== 1 ||
    record.captureId !== id ||
    !['editor_2d', 'editor_3d', 'runtime'].includes(String(record.source))
  )
    throw new Error('Unsupported annotation capture');
  dimension(record.width);
  dimension(record.height);
  if (Number(record.width) * Number(record.height) > 16777216)
    throw new Error('Image pixel budget exceeded');
  boundedString(record.createdAt, 64);
  boundedString(record.scenePath);
  if (
    !Array.isArray(record.annotations) ||
    !record.annotations.length ||
    record.annotations.length > 100
  )
    throw new Error('Invalid annotations');
  const annotations = record.annotations.map((item) => {
    const mark = object(item);
    const comment = boundedString(mark.comment);
    if (!comment.trim()) throw new Error('Annotation requires a comment');
    if (!['rectangle', 'pin'].includes(String(mark.kind)))
      throw new Error('Invalid annotation kind');
    const region = object(mark.region);
    for (const key of ['x', 'y', 'width', 'height'])
      if (
        typeof region[key] !== 'number' ||
        !Number.isFinite(region[key]) ||
        Number(region[key]) < 0 ||
        Number(region[key]) > 1
      )
        throw new Error('Invalid normalized region');
    if (
      Number(region.x) + Number(region.width) > 1.000001 ||
      Number(region.y) + Number(region.height) > 1.000001
    )
      throw new Error('Region exceeds image');
    const nodePath = mark.nodePath === undefined ? undefined : boundedString(mark.nodePath);
    return {
      kind: mark.kind,
      region,
      comment,
      ...(nodePath ? { nodePath, nodeProvenance: 'user-selected' } : {}),
    };
  });
  return {
    schemaVersion: 1,
    captureId: id,
    source: record.source,
    scenePath: record.scenePath,
    createdAt: record.createdAt,
    width: record.width,
    height: record.height,
    annotations,
  };
}
async function state(root: string, id: string) {
  const bytes = await optionalFile(await dataPath(root, `${id}/status.json`));
  const statuses: Record<string, string> = bytes
    ? (object(JSON.parse(bytes.toString())) as Record<string, string>)
    : {};
  for (const [key, value] of Object.entries(statuses))
    if (!/^[0-9]{1,2}$/.test(key) || !['open', 'resolved'].includes(value))
      throw new Error('Invalid annotation status data');
  return { statuses, revision: hash(bytes ?? '') };
}
async function png(root: string, id: string, name: string, width: unknown, height: unknown) {
  const bytes = await optionalFile(await dataPath(root, `${id}/${name}.png`), 8 * 1024 * 1024);
  if (
    !bytes ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw new Error('Invalid capture PNG');
  return bytes.toString('base64');
}
const queues = new Map<string, Promise<unknown>>();
async function resolveRecord(root: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const { captureId, index } = annotationId(args.annotationId);
  if (args.status !== 'open' && args.status !== 'resolved')
    throw new Error('Invalid annotation status');
  const path = await dataPath(root, `${captureId}/status.json`);
  const previous = queues.get(path) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const record = await capture(root, captureId);
      if (!record.annotations[index]) throw new Error('Annotation not found');
      const current = await state(root, captureId);
      if (args.expectedRevision !== current.revision)
        throw new Error('Annotation revision changed');
      const lock = `${path}.lock`;
      await mkdir(lock).catch(() => {
        throw new Error('Annotation status is locked by another writer');
      });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        if ((await state(root, captureId)).revision !== current.revision)
          throw new Error('Annotation revision changed');
        const bytes = JSON.stringify({ ...current.statuses, [index]: args.status });
        signal?.throwIfAborted();
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
        return { annotationId: args.annotationId, status: args.status, revision: hash(bytes) };
      } finally {
        await rm(temporary, { force: true });
        await rm(lock, { recursive: true, force: true });
      }
    });
  queues.set(path, task);
  try {
    return await task;
  } finally {
    if (queues.get(path) === task) queues.delete(path);
  }
}
export async function handleAnnotationTool(
  name: string,
  args: Record<string, unknown>,
  scripts: string,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const root = await projectRoot(args.projectPath);
  signal?.throwIfAborted();
  if (name === 'ensure_annotation_addon' || name === 'remove_annotation_addon')
    return text(await changeAddon(root, scripts, name === 'remove_annotation_addon', args, signal));
  if (name === 'get_annotation_status') {
    const installed = await installedAddon(root);
    const enabled = await withProjectConfig(root, async (snapshot) =>
      pluginList(snapshot.original, snapshot.document.entries).includes(
        'res://addons/godot_mcp_annotations/plugin.cfg',
      ),
    );
    const directory = await dataPath(root);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const presences = [];
    for (const name of names
      .filter((name) => /^(editor|runtime)-[0-9]+\.json$/.test(name))
      .slice(0, 100)) {
      const bytes = await optionalFile(await dataPath(root, name), 4096);
      if (!bytes) continue;
      try {
        const presence = object(JSON.parse(bytes.toString()));
        const age = Date.now() / 1000 - Number(presence.updatedAt);
        if (
          age >= -5 &&
          age < 15 &&
          presence.schemaVersion === 1 &&
          ['editor', 'runtime'].includes(String(presence.kind)) &&
          Number.isInteger(presence.pid) &&
          name === `${presence.kind}-${presence.pid}.json`
        )
          presences.push(presence);
      } catch {
        /* Ignore stale or incomplete presence; captures are validated separately. */
      }
    }
    return text({
      installed: !!installed.manifest,
      version: installed.manifest?.version ?? null,
      enabled,
      editorReady:
        enabled &&
        presences.some(
          (item) => item.kind === 'editor' && item.version === installed.manifest?.version,
        ),
      presences,
      storage: annotationDirectory,
      transport: 'local submitted files; no remote commands',
      nextAction:
        enabled && !presences.some((item) => item.kind === 'editor')
          ? 'Open or reopen the project after saving editor work.'
          : null,
    });
  }
  if (name === 'resolve_annotation') return text(await resolveRecord(root, args, signal));
  if (name === 'get_annotation') {
    const { captureId, index } = annotationId(args.annotationId);
    const record = await capture(root, captureId);
    const annotation = record.annotations[index];
    if (!annotation) throw new Error('Annotation not found');
    const { annotations: _annotations, ...context } = record;
    const current = await state(root, captureId);
    const metadata = {
      ...context,
      annotationId: args.annotationId,
      ...annotation,
      status: current.statuses[index] ?? 'open',
      revision: current.revision,
      contentTrust: 'user-supplied comment and scene context',
    };
    const original = await png(root, captureId, 'original', record.width, record.height);
    const marked = await png(root, captureId, 'marked', record.width, record.height);
    return {
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', mimeType: 'image/png', data: original },
        { type: 'image', mimeType: 'image/png', data: marked },
      ],
      structuredContent: metadata,
    };
  }
  if (name === 'list_annotations') {
    const limit = args.limit ?? 25;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('limit must be 1 to 100');
    const filter = args.status ?? 'open';
    if (!['open', 'resolved', 'all'].includes(String(filter)))
      throw new Error('Invalid status filter');
    if (args.cursor !== undefined) annotationId(args.cursor);
    const directory = await dataPath(root);
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const ids = entries
      .filter((item) => item.isDirectory() && capturePattern.test(item.name))
      .map((item) => item.name)
      .sort();
    if (ids.length > 1000)
      throw new Error('More than 1000 captures; archive older captures before listing');
    const annotations = [];
    const errors = [];
    for (const id of ids) {
      signal?.throwIfAborted();
      if (args.cursor && id < String(args.cursor).slice(0, 32)) continue;
      try {
        const record = await capture(root, id);
        const current = await state(root, id);
        for (let index = 0; index < record.annotations.length; index++) {
          const annotationId = `${id}-${String(index).padStart(2, '0')}`;
          if (args.cursor && annotationId <= String(args.cursor)) continue;
          const status = current.statuses[index] ?? 'open';
          if (filter !== 'all' && status !== filter) continue;
          annotations.push({
            annotationId,
            captureId: id,
            scenePath: record.scenePath,
            source: record.source,
            createdAt: record.createdAt,
            ...record.annotations[index],
            status,
            revision: current.revision,
          });
          if (annotations.length > limit)
            return text({
              annotations: annotations.slice(0, limit),
              nextCursor: annotations[limit - 1].annotationId,
              errors,
            });
        }
      } catch (error) {
        errors.push({
          captureId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (errors.length >= 25) break;
      }
    }
    return text({ annotations, nextCursor: null, errors });
  }
  throw new Error('Unknown annotation tool');
}
