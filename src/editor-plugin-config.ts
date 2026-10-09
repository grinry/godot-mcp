import { patchProjectConfig } from './project-config.js';

export function pluginList(
  original: string,
  entries: { section: string; key: string; valueStart: number; valueEnd: number }[],
) {
  const entry = entries.find((item) => item.section === 'editor_plugins' && item.key === 'enabled');
  if (!entry) return [];
  const expression = original.slice(entry.valueStart, entry.valueEnd);
  const match = expression.match(/^PackedStringArray\(([\s\S]*)\)$/);
  if (!match) throw new Error('Unsupported enabled-plugin expression; settings were not changed');
  const values: unknown = JSON.parse(`[${match[1]}]`);
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
    throw new Error('Invalid enabled-plugin list');
  return values as string[];
}

export function pluginSetting(
  original: string,
  entries: Parameters<typeof pluginList>[1],
  pluginPath: string,
  enabled: boolean,
) {
  const previous = pluginList(original, entries);
  const next = enabled
    ? [...new Set([...previous, pluginPath])]
    : previous.filter((item) => item !== pluginPath);
  if (JSON.stringify(previous) === JSON.stringify(next)) return original;
  return patchProjectConfig(
    original,
    'editor_plugins',
    'enabled',
    `PackedStringArray(${next.map((item) => JSON.stringify(item)).join(', ')})`,
  );
}
