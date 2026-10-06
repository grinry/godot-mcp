import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OperationRunner, requireSuccess } from './operation-runner.js';
import { patchProjectConfig, saveProjectConfig, withProjectConfig } from './project-config.js';
import { projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';

const string = { type: 'string' };
const primitive = [
  { type: 'null' },
  { type: 'boolean' },
  { type: 'number' },
  string,
  { type: 'object', additionalProperties: true },
];
// Recursive JSON collections are bounded and type-checked by the engine decoder.
const valueSchema = {
  anyOf: [...primitive, { type: 'array', items: { $ref: '#/$defs/settingValue' } }],
};
const eventSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['key', 'mouse_button', 'joypad_button', 'joypad_motion'] },
    key: { anyOf: [string, { type: 'null' }] },
    keycode: { type: 'integer', minimum: 1, maximum: 2147483647 },
    physicalKeycode: { type: 'integer', minimum: 1, maximum: 2147483647 },
    button: { type: 'integer', minimum: 0, maximum: 127 },
    axis: { type: 'integer', minimum: 0, maximum: 9 },
    axisValue: { type: 'number', enum: [-1, 1] },
    device: { type: 'integer', minimum: -1, maximum: 255 },
    ctrl: { type: 'boolean' },
    shift: { type: 'boolean' },
    alt: { type: 'boolean' },
    meta: { type: 'boolean' },
    commandOrControl: { type: 'boolean' },
  },
  required: ['kind'],
  additionalProperties: false,
};
const descriptions = {
  get_project_setting:
    'Read a stored project.godot expression without starting Godot. Returns sourceHash and stored:false for absent entries; does not resolve defaults, feature tags or override.cfg.',
  set_project_setting:
    'Set a typed project setting with isolated Godot validation, preserving unrelated comments/values. Supports dryRun and expectedHash. Use dedicated tools for input and autoload sections.',
  remove_project_setting:
    'Remove a stored project setting override, preserving unrelated configuration. Engine defaults may apply afterward. Supports dryRun and expectedHash.',
  register_autoload:
    'Register a named singleton or plain autoload using an existing .gd/.cs/.tscn/.scn path. Checks path and built-in name conflicts, not script/runtime compatibility. Refuses replacing a different entry unless replace:true. Supports dryRun and expectedHash.',
  unregister_autoload:
    'Remove a stored autoload entry with a preview/source-hash guard. Does not change already-running games.',
  get_input_actions:
    'Inspect configured input actions and key/mouse/joypad bindings through an isolated ConfigFile parser. Does not include engine defaults or live InputMap changes; no project autoloads are started.',
  set_input_action:
    'Create or replace a configured action and its complete binding list. Preserves deadzone when omitted on an existing action. Supports key, mouse button and joypad bindings, dryRun and expectedHash.',
  remove_input_action:
    'Remove a configured input action. Removing a built-in override restores its default on next launch; this does not disable a built-in action. Supports dryRun and expectedHash.',
};
export const configurationTools: ToolSpecification[] = Object.entries(descriptions).map(
  ([name, description]) => {
    const reading = name === 'get_project_setting' || name === 'get_input_actions';
    const setting = name.includes('project_setting');
    const autoload = name.includes('autoload');
    return {
      name,
      description,
      session: 'none',
      access: name === 'get_project_setting' ? 'read' : 'execute',
      annotations: {
        destructiveHint:
          name.startsWith('remove_') ||
          name === 'unregister_autoload' ||
          name === 'set_input_action',
      },
      inputSchema: {
        type: 'object',
        ...(name === 'set_project_setting' ? { $defs: { settingValue: valueSchema } } : {}),
        properties: {
          projectPath: string,
          ...(setting ? { setting: string } : autoload ? { name: string } : { action: string }),
          ...(name === 'set_project_setting' ? { value: valueSchema } : {}),
          ...(name === 'register_autoload'
            ? { resourcePath: string, singleton: { type: 'boolean' }, replace: { type: 'boolean' } }
            : {}),
          ...(name === 'get_input_actions'
            ? { limit: { type: 'integer', minimum: 1, maximum: 200 } }
            : {}),
          ...(name === 'set_input_action'
            ? {
                deadzone: { type: 'number', minimum: 0, maximum: 1 },
                events: { type: 'array', minItems: 0, maxItems: 32, items: eventSchema },
              }
            : {}),
          ...(!reading ? { dryRun: { type: 'boolean' }, expectedHash: string } : {}),
        },
        required: [
          'projectPath',
          ...(setting
            ? ['setting']
            : autoload
              ? ['name']
              : name === 'get_input_actions'
                ? []
                : ['action']),
          ...(name === 'set_project_setting'
            ? ['value']
            : name === 'register_autoload'
              ? ['resourcePath']
              : name === 'set_input_action'
                ? ['events']
                : []),
        ],
      },
      outputSchema: {
        type: 'object',
        properties: {
          sourceHash: string,
          saved: { type: 'boolean' },
          stored: { type: 'boolean' },
          setting: string,
          expression: { anyOf: [string, { type: 'null' }] },
          actions: { type: 'array', items: { type: 'object' } },
          configuredOnly: { type: 'boolean' },
          truncated: { type: 'boolean' },
          section: string,
          key: { anyOf: [string, { type: 'null' }] },
        },
        required: ['sourceHash', 'saved'],
      },
    };
  },
);

function identifier(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function settingPath(value: unknown, writing: boolean) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z0-9_./-]{1,255}$/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('setting must be a section/key path');
  const split = value.indexOf('/');
  const section = value.slice(0, split);
  if (writing && (section === 'autoload' || section === 'input'))
    throw new Error('Use the dedicated autoload/InputMap tools');
  return { section, key: value.slice(split + 1) };
}

/** Check native InputMap binding shapes before invoking the engine. */
export function validateBindings(value: unknown) {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error('events must contain up to 32 bindings');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid input binding');
    const event = entry as Record<string, unknown>;
    const number = (key: string, min: number, max: number, fallback?: number) => {
      const item = event[key] ?? fallback;
      if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max)
        throw new Error(`Invalid ${key}`);
      return item;
    };
    const binding: Record<string, unknown> = {
      kind: event.kind,
      device: number('device', -1, 255, -1),
    };
    if (event.kind === 'key' || event.kind === 'mouse_button')
      for (const key of ['ctrl', 'shift', 'alt', 'meta', 'commandOrControl']) {
        if (event[key] !== undefined && typeof event[key] !== 'boolean')
          throw new Error(`Invalid ${key}`);
        binding[key] = event[key] ?? false;
      }
    if (binding.commandOrControl === true && (binding.ctrl === true || binding.meta === true))
      throw new Error('commandOrControl cannot be combined with ctrl/meta');
    if (event.kind === 'key') {
      if (
        ['key', 'keycode', 'physicalKeycode'].filter((key) => event[key] !== undefined).length !== 1
      )
        throw new Error('Choose exactly one key, keycode or physicalKeycode');
      if (event.key !== undefined) {
        if (typeof event.key !== 'string' || !event.key || event.key.length > 64)
          throw new Error('Invalid key');
        binding.key = event.key;
      } else {
        const key = event.keycode !== undefined ? 'keycode' : 'physicalKeycode';
        binding[key] = number(key, 1, 0x7fffffff);
      }
    } else if (event.kind === 'mouse_button') binding.button = number('button', 1, 9);
    else if (event.kind === 'joypad_button') binding.button = number('button', 0, 127);
    else if (event.kind === 'joypad_motion') {
      binding.axis = number('axis', 0, 9);
      if (event.axisValue !== -1 && event.axisValue !== 1)
        throw new Error('axisValue must be -1 or 1');
      binding.axisValue = event.axisValue;
    } else throw new Error('Unsupported input binding kind');
    const allowed = new Set(Object.keys(binding));
    for (const key of Object.keys(event))
      if (!allowed.has(key)) throw new Error(`Unexpected input binding field: ${key}`);
    return binding;
  });
}

/** Serialize one target through isolated Godot and atomically patch project.godot. */
export async function handleConfigurationTool(
  name: string,
  args: Record<string, unknown>,
  godot: string,
  scripts: string,
  runner: OperationRunner,
  signal?: AbortSignal,
) {
  const root = await projectRoot(args.projectPath);
  const reading = name === 'get_project_setting' || name === 'get_input_actions';
  const params: Record<string, unknown> = {};
  if (name.includes('project_setting'))
    Object.assign(params, settingPath(args.setting, name !== 'get_project_setting'));
  else if (name.includes('autoload')) {
    params.section = 'autoload';
    params.key = identifier(args.name, 'autoload name');
  } else {
    params.section = 'input';
    if (args.action !== undefined) params.key = identifier(args.action, 'action');
  }
  if (name === 'register_autoload') {
    const file = await projectFile(root, args.resourcePath, ['.gd', '.cs', '.tscn', '.scn']);
    for (const key of ['singleton', 'replace'])
      if (args[key] !== undefined && typeof args[key] !== 'boolean')
        throw new Error(`${key} must be boolean`);
    params.autoload = (args.singleton !== false ? '*' : '') + file.resource;
    params.replace = args.replace === true;
  }
  if (name === 'set_project_setting') {
    if (!Object.hasOwn(args, 'value') || args.value === null || args.value === undefined)
      throw new Error('value is required; use remove_project_setting to remove an override');
    params.value = args.value;
    if (args.setting === 'application/run/main_scene')
      params.value = (await projectFile(root, args.value, ['.tscn', '.scn'])).resource;
  }
  if (name === 'set_input_action') {
    params.events = validateBindings(args.events);
    if (
      args.deadzone !== undefined &&
      (typeof args.deadzone !== 'number' ||
        !Number.isFinite(args.deadzone) ||
        args.deadzone < 0 ||
        args.deadzone > 1)
    )
      throw new Error('deadzone must be between 0 and 1');
    if (args.deadzone !== undefined) params.deadzone = args.deadzone;
  }
  if (name === 'get_input_actions') {
    const limit = args.limit ?? 100;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('limit must be between 1 and 200');
    params.limit = limit;
  }
  if (!reading && args.dryRun !== undefined && typeof args.dryRun !== 'boolean')
    throw new Error('dryRun must be boolean');
  if (Buffer.byteLength(JSON.stringify(params)) > 60000)
    throw new Error('Configuration request exceeds 60 KiB');
  return withProjectConfig(root, async (snapshot) => {
    signal?.throwIfAborted();
    if (args.expectedHash !== undefined && args.expectedHash !== snapshot.sourceHash)
      throw new Error('Project settings changed since preview');
    if (name === 'get_project_setting') {
      const entry = snapshot.document.entries.find(
        (item) => item.section === params.section && item.key === params.key,
      );
      const data = {
        sourceHash: snapshot.sourceHash,
        saved: false,
        setting: args.setting,
        stored: !!entry,
        expression: entry ? snapshot.original.slice(entry.valueStart, entry.valueEnd) : null,
        serializedOnly: true,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    }
    const directory = await mkdtemp(join(tmpdir(), 'godot-mcp-config-'));
    try {
      const inputPath = join(directory, 'source.cfg');
      await writeFile(inputPath, snapshot.original, { mode: 0o600 });
      const run = async (operation: string, extra: Record<string, unknown> = {}) => {
        const child = await runner.run(
          godot,
          [
            '--headless',
            '--path',
            directory,
            '--script',
            join(scripts, 'configuration.gd'),
            '--',
            operation,
            JSON.stringify({ ...params, inputPath, ...extra }),
          ],
          60000,
          signal,
        );
        requireSuccess(child);
        const line = child.output.find((item) => item.startsWith('GODOT_MCP_RESULT '));
        if (!line) throw new Error('Godot did not return a configuration result');
        return JSON.parse(line.slice('GODOT_MCP_RESULT '.length));
      };
      const result = await run(name);
      if (!reading) {
        const candidate = patchProjectConfig(
          snapshot.original,
          String(params.section),
          String(params.key),
          result.expression ?? null,
        );
        const candidatePath = join(directory, 'candidate.cfg');
        await writeFile(candidatePath, candidate, { mode: 0o600 });
        await run('verify', { candidatePath, expression: result.expression ?? null });
        await saveProjectConfig(snapshot, candidate, args.dryRun === true, signal);
      }
      const data = {
        ...result,
        sourceHash: snapshot.sourceHash,
        saved: !reading && args.dryRun !== true,
        section: params.section,
        key: params.key ?? null,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
