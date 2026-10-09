import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSetting } from './editor-plugin-config.js';
import {
  parseProjectConfig,
  patchProjectConfig,
  saveProjectConfig,
  withProjectConfig,
} from './project-config.js';
import { projectOutput } from './project-paths.js';

export const addonResource = 'res://addons/godot_mcp_annotations/plugin.cfg';
export const annotationDirectory = '.godot-mcp/annotations';
const exportExclusions = ['addons/godot_mcp_annotations/*', '.godot-mcp/*'];

async function exportSnapshot(root: string) {
  const file = (await projectOutput(root, 'export_presets.cfg')).path;
  const bytes = await optionalFile(file, 1024 * 1024);
  if (!bytes) return undefined;
  const original = bytes.toString('utf8');
  if (!Buffer.from(original).equals(bytes)) throw new Error('Export presets are not UTF-8');
  const document = parseProjectConfig(original);
  let updated = original;
  for (const section of document.sections.filter((item) => /^preset\.[0-9]+$/.test(item.name))) {
    const entry = document.entries.find(
      (item) => item.section === section.name && item.key === 'exclude_filter',
    );
    const filter: unknown = entry
      ? JSON.parse(original.slice(entry.valueStart, entry.valueEnd))
      : '';
    if (typeof filter !== 'string') throw new Error('Unsupported export exclude filter');
    const existing = filter.split(',').map((item) => item.trim());
    const missing = exportExclusions.filter((item) => !existing.includes(item));
    if (missing.length)
      updated = patchProjectConfig(
        updated,
        section.name,
        'exclude_filter',
        JSON.stringify([filter, ...missing].filter(Boolean).join(',')),
      );
  }
  return { file, original, sourceHash: hash(original), document, updated };
}
export interface AddonManifest {
  version: string;
  schemaVersion: number;
  files: Record<string, string>;
}
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function optionalFile(path: string, limit = 65536): Promise<Buffer | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Expected a bounded regular file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('File exceeds limit');
  return bytes;
}
function manifest(bytes: Buffer): AddonManifest {
  const value = JSON.parse(bytes.toString());
  if (
    value.schemaVersion !== 1 ||
    typeof value.version !== 'string' ||
    !value.files ||
    typeof value.files !== 'object'
  )
    throw new Error('Unsupported addon manifest');
  for (const [name, digest] of Object.entries(value.files)) {
    if (
      !/^[a-z_]+\.(gd|tscn|cfg|txt)$/.test(name) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error('Invalid addon manifest entry');
  }
  if (!value.files['plugin.cfg']) throw new Error('Missing addon plugin.cfg');
  return value;
}
export async function installedAddon(root: string) {
  const target = (await projectOutput(root, 'addons/godot_mcp_annotations')).path;
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!entry) return { target, manifest: undefined };
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error('Addon directory must not be a symlink');
  const bytes = await optionalFile(join(target, 'manifest.json'));
  if (!bytes) throw new Error('Existing addon is not owned by godot-mcp');
  const owned = manifest(bytes);
  for (const [name, digest] of Object.entries(owned.files)) {
    const file = await optionalFile(join(target, name), 1024 * 1024);
    if (!file || hash(file) !== digest) throw new Error(`Addon file was modified: ${name}`);
  }
  for (const name of await readdir(target)) {
    // Godot generates .uid sidecars for scripts. They are safe to retain on update.
    if (
      name !== 'manifest.json' &&
      !(name in owned.files) &&
      !(name.endsWith('.gd.uid') && name.slice(0, -4) in owned.files)
    )
      throw new Error(`Unowned addon file: ${name}`);
    if ((await lstat(join(target, name))).isSymbolicLink())
      throw new Error('Addon contains a symlink');
    if (name.endsWith('.gd.uid')) {
      const uid = await optionalFile(join(target, name), 1024);
      if (!uid || !/^uid:\/\/[a-z0-9]+\r?\n?$/i.test(uid.toString()))
        throw new Error('Invalid addon UID sidecar');
    }
  }
  return { target, manifest: owned };
}
export async function changeAddon(
  root: string,
  scripts: string,
  remove: boolean,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')
    throw new Error('dryRun must be boolean');
  if (args.expectedHash !== undefined && typeof args.expectedHash !== 'string')
    throw new Error('expectedHash must be a string');
  if (args.expectedExportHash !== undefined && typeof args.expectedExportHash !== 'string')
    throw new Error('expectedExportHash must be a string');
  const source = join(scripts, 'annotation_addon');
  const bundled = manifest(await readFile(join(source, 'manifest.json')));
  return withProjectConfig(root, async (snapshot) => {
    signal?.throwIfAborted();
    if (args.expectedHash !== undefined && args.expectedHash !== snapshot.sourceHash)
      throw new Error('Project settings hash changed');
    const installed = await installedAddon(root);
    const exports = remove ? undefined : await exportSnapshot(root);
    if (args.expectedExportHash !== undefined && args.expectedExportHash !== exports?.sourceHash)
      throw new Error('Export presets hash changed');
    const updated = pluginSetting(
      snapshot.original,
      snapshot.document.entries,
      addonResource,
      !remove,
    );
    const editorReady = !remove && (await annotationEditorReady(root, bundled.version));
    const replace =
      !remove &&
      (!installed.manifest || JSON.stringify(installed.manifest) !== JSON.stringify(bundled));
    const changed =
      updated !== snapshot.original ||
      replace ||
      (remove && !!installed.manifest) ||
      (!!exports && exports.updated !== exports.original);
    const result = {
      changed,
      dryRun: args.dryRun === true,
      sourceHash: snapshot.sourceHash,
      exportSourceHash: exports?.sourceHash ?? null,
      exportExclusionsUpdated: !!exports && exports.updated !== exports.original,
      version: remove ? null : bundled.version,
      enabled: !remove,
      configuredEnabled: !remove,
      editorReady,
      activation: remove
        ? 'disabled_in_configuration'
        : editorReady
          ? 'active'
          : 'editor_reload_required',
      nextAction: remove
        ? 'Reopen an already-running editor to unload the addon; annotation data was preserved.'
        : editorReady
          ? 'The addon reports active editor presence.'
          : 'Enablement is saved. Open the project, or save and reopen an already-open editor to activate it.',
    };
    if (args.dryRun === true || !changed) return result;
    await mkdir(join(root, 'addons'), { recursive: true });
    const staging = `${installed.target}.${randomUUID()}.tmp`;
    const backup = `${installed.target}.${randomUUID()}.backup`;
    let backedUp = false;
    let published = false;
    let exportsSaved = false;
    try {
      if (replace) {
        await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
        for (const [name, digest] of Object.entries(bundled.files))
          if (hash(await readFile(join(staging, name))) !== digest)
            throw new Error('Bundled addon checksum mismatch');
        if (installed.manifest) {
          for (const name of await readdir(installed.target))
            if (name.endsWith('.gd.uid') && name.slice(0, -4) in bundled.files)
              await cp(join(installed.target, name), join(staging, name));
        }
      }
      // Recheck ownership immediately before moving an existing installation.
      await installedAddon(root);
      signal?.throwIfAborted();
      if (installed.manifest && (replace || remove)) {
        await rename(installed.target, backup);
        backedUp = true;
      }
      if (replace) {
        await rename(staging, installed.target);
        published = true;
      }
      if (exports && exports.updated !== exports.original) {
        await saveProjectConfig(exports, exports.updated, false, signal);
        exportsSaved = true;
      }
      await saveProjectConfig(snapshot, updated, false, signal);
    } catch (error) {
      if (exportsSaved && exports && (await readFile(exports.file, 'utf8')) === exports.updated) {
        await saveProjectConfig({ ...exports, original: exports.updated }, exports.original, false);
      }
      if (published) await rm(installed.target, { recursive: true, force: true });
      if (backedUp) await rename(backup, installed.target);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return result;
  });
}

export async function annotationEditorReady(root: string, version: string) {
  const directory = (await projectOutput(root, annotationDirectory)).path;
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of files.filter((item) => /^editor-[0-9]+\.json$/.test(item)).slice(0, 100)) {
    try {
      const bytes = await optionalFile(join(directory, name), 4096);
      if (!bytes) continue;
      const presence = JSON.parse(bytes.toString());
      const age = Date.now() / 1000 - Number(presence.updatedAt);
      if (
        presence.schemaVersion === 1 &&
        presence.kind === 'editor' &&
        presence.version === version &&
        Number.isInteger(presence.pid) &&
        name === `editor-${presence.pid}.json` &&
        age >= -5 &&
        age < 15
      )
        return true;
    } catch {
      /* Unreadable presence is not proof of activation. */
    }
  }
  return false;
}
