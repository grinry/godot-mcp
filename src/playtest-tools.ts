import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nodePath } from './authoring-tools.js';
import { diagnosticCounts, parseDiagnostics } from './diagnostics.js';
import type { GodotSession } from './godot-session.js';
import { projectFile, projectRoot } from './project-paths.js';
import type { ToolSpecification } from './tool-types.js';
import { inputParameters } from './workflow-tools.js';

const string = { type: 'string' };
const comparisons = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'approx'] as const;
type Comparison = (typeof comparisons)[number];
type Step =
  | { op: 'input'; event: Record<string, unknown> }
  | { op: 'frames'; frames: number; kind: 'process' | 'physics' }
  | {
      op: 'assert';
      nodePath: string;
      property: string;
      comparison: Comparison;
      expected: unknown;
      tolerance: number;
    }
  | { op: 'screenshot' };

export const playtestTools: ToolSpecification[] = [
  {
    name: 'run_playtest',
    access: 'execute',
    session: 'start',
    description:
      'Run bounded input/frame/assertion/screenshot steps in a fresh temporary debug session and always stop its game. Queued inputs are delivered on the following frame step. Returns evidence and pass/fail; does not promise deterministic simulation. Replaces the game in the selected session.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: string,
        scenePath: string,
        headless: { type: 'boolean', default: true },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, default: 60000 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  op: { const: 'input' },
                  event: {
                    type: 'object',
                    properties: {
                      kind: {
                        type: 'string',
                        enum: ['action', 'key', 'mouse_button', 'mouse_motion'],
                      },
                      action: string,
                      pressed: { type: 'boolean' },
                      strength: { type: 'number', minimum: 0, maximum: 1 },
                      keycode: { type: 'integer', minimum: 1 },
                      button: { type: 'integer', minimum: 1, maximum: 9 },
                      x: { type: 'number' },
                      y: { type: 'number' },
                    },
                    required: ['kind'],
                    additionalProperties: false,
                  },
                },
                required: ['op', 'event'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'frames' },
                  frames: { type: 'integer', minimum: 1, maximum: 120 },
                  kind: { type: 'string', enum: ['process', 'physics'] },
                },
                required: ['op', 'frames'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  op: { const: 'assert' },
                  nodePath: string,
                  property: string,
                  comparison: { type: 'string', enum: [...comparisons] },
                  expected: {
                    anyOf: [
                      { type: 'null' },
                      { type: 'boolean' },
                      { type: 'number' },
                      { type: 'string' },
                      { type: 'object', additionalProperties: true },
                    ],
                    description:
                      'A primitive or explicit typed object returned by get_node_properties; collections use their encoded object shape.',
                  },
                  tolerance: { type: 'number', minimum: 0 },
                },
                required: ['op', 'nodePath', 'property', 'expected'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { op: { const: 'screenshot' } },
                required: ['op'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['projectPath', 'steps'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        stopped: { type: 'boolean' },
        steps: { type: 'array', items: { type: 'object' } },
        requestedSteps: { type: 'integer' },
        completedSteps: { type: 'integer' },
        screenshotCount: { type: 'integer' },
        diagnostics: { type: 'array', items: { type: 'object' } },
        error: { type: 'string' },
        code: { type: 'string' },
      },
      required: [
        'passed',
        'stopped',
        'steps',
        'requestedSteps',
        'completedSteps',
        'screenshotCount',
        'diagnostics',
      ],
    },
  },
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}

function finiteValues(value: unknown, depth = 0): void {
  if (depth > 6) throw new Error('Expected value nesting exceeds six levels');
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Expected values must be finite');
  if (value && typeof value === 'object')
    for (const child of Object.values(value)) finiteValues(child, depth + 1);
}

/** Validate the complete scenario before replacing any running game. */
export function validatePlaytest(args: Record<string, unknown>) {
  if (args.headless !== undefined && typeof args.headless !== 'boolean')
    throw new Error('headless must be boolean');
  const timeoutMs = integer(args.timeoutMs ?? 60000, 1, 600000, 'timeoutMs');
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 100)
    throw new Error('steps must contain 1 to 100 entries');
  if (Buffer.byteLength(JSON.stringify(args.steps)) > 60000)
    throw new Error('Playtest steps exceed 60 KiB');
  let frames = 0;
  let screenshots = 0;
  let assertions = 0;
  let queued = false;
  const steps = args.steps.map((value): Step => {
    const step = object(value);
    if (step.op === 'input') {
      queued = true;
      return { op: 'input', event: inputParameters(object(step.event)) };
    }
    if (step.op === 'frames') {
      const count = integer(step.frames, 1, 120, 'frames');
      frames += count;
      if (frames > 1200) throw new Error('Playtests are limited to 1200 total frames');
      const kind = step.kind ?? 'physics';
      if (kind !== 'process' && kind !== 'physics')
        throw new Error('kind must be physics or process');
      queued = false;
      return { op: 'frames', frames: count, kind };
    }
    if (queued) throw new Error('Follow queued input with a frames step before inspecting state');
    if (step.op === 'screenshot') {
      screenshots += 1;
      if (screenshots > 3) throw new Error('Playtests are limited to three screenshots');
      if (args.headless !== false) throw new Error('Screenshots require headless:false');
      return { op: 'screenshot' };
    }
    if (step.op !== 'assert') throw new Error('Unknown playtest step');
    assertions += 1;
    if (assertions > 50) throw new Error('Playtests are limited to 50 assertions');
    if (
      typeof step.property !== 'string' ||
      !step.property ||
      step.property.length > 128 ||
      step.property.includes('\0')
    )
      throw new Error('property must be a valid property name');
    if (!Object.hasOwn(step, 'expected')) throw new Error('Assertions require expected');
    if (step.expected === undefined || Array.isArray(step.expected))
      throw new Error('Expected must be a primitive or encoded typed object');
    finiteValues(step.expected);
    if (Buffer.byteLength(JSON.stringify(step.expected)) > 4096)
      throw new Error('Expected value exceeds 4 KiB');
    const comparison = step.comparison ?? 'eq';
    if (!comparisons.includes(comparison as Comparison))
      throw new Error('Invalid assertion comparison');
    const tolerance = step.tolerance ?? 0.00001;
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0)
      throw new Error('tolerance must be a finite non-negative number');
    if (
      ['lt', 'lte', 'gt', 'gte'].includes(String(comparison)) &&
      typeof step.expected !== 'number'
    )
      throw new Error('Ordered comparisons require a numeric expected value');
    return {
      op: 'assert',
      nodePath: nodePath(step.nodePath),
      property: step.property,
      comparison: comparison as Comparison,
      expected: step.expected,
      tolerance,
    };
  });
  if (queued) throw new Error('Playtests must finish delivering input with a frames step');
  if (assertions === 0) throw new Error('Playtests require at least one state assertion');
  return { steps, timeoutMs };
}

/** A bounded encoded value must be complete before it can be asserted. */
function completeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(completeValue);
  if (value && typeof value === 'object') {
    const record = object(value);
    if (record.truncated === true || record.unsupported === true)
      throw new Error('Cannot assert truncated or unsupported values');
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== 'truncated')
        .map(([key, child]) => [key, completeValue(child)]),
    );
  }
  return value;
}

function approximate(actual: unknown, expected: unknown, tolerance: number): boolean {
  if (typeof actual === 'number' && typeof expected === 'number')
    return Math.abs(actual - expected) <= tolerance;
  if (Array.isArray(actual) && Array.isArray(expected))
    return (
      actual.length === expected.length &&
      actual.every((value, index) => approximate(value, expected[index], tolerance))
    );
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const left = object(actual);
    const right = object(expected);
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(
        ([key, value]) => Object.hasOwn(right, key) && approximate(value, right[key], tolerance),
      )
    );
  }
  return isDeepStrictEqual(actual, expected);
}

export function compareState(
  actual: unknown,
  expected: unknown,
  comparison: Comparison,
  tolerance: number,
) {
  actual = completeValue(actual);
  expected = completeValue(expected);
  if (comparison === 'eq') return isDeepStrictEqual(actual, expected);
  if (comparison === 'ne') return !isDeepStrictEqual(actual, expected);
  if (comparison === 'approx') return approximate(actual, expected, tolerance);
  if (typeof actual !== 'number' || !Number.isFinite(actual) || typeof expected !== 'number')
    throw new Error('Ordered comparisons require finite numeric values');
  if (comparison === 'lt') return actual < expected;
  if (comparison === 'lte') return actual <= expected;
  if (comparison === 'gt') return actual > expected;
  return actual >= expected;
}

/** Own one session's game for the duration of the scenario, including error cleanup. */
export async function runPlaytest(
  args: Record<string, unknown>,
  session: GodotSession,
  godot: string,
  scripts: string,
  signal?: AbortSignal,
) {
  const { steps, timeoutMs } = validatePlaytest(args);
  const root = await projectRoot(args.projectPath);
  const scene =
    args.scenePath === undefined
      ? ''
      : (await projectFile(root, args.scenePath, ['.tscn', '.scn'])).resource;
  const timeout = AbortSignal.timeout(timeoutMs);
  const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const results: Record<string, unknown>[] = [];
  const images: { type: 'image'; mimeType: string; data: string }[] = [];
  let failure: { error: string; code: string } | undefined;
  let started = false;
  let attempted = false;
  let stopped = false;
  try {
    runSignal.throwIfAborted();
    attempted = true;
    await session.live.start(
      godot,
      root,
      join(scripts, 'live_session.gd'),
      scene,
      args.headless !== false,
      runSignal,
    );
    started = true;
    await session.live.request('pause', { paused: true }, runSignal);
    for (const step of steps) {
      let result: Record<string, unknown> = { op: step.op };
      if (step.op === 'input') {
        await session.live.request('input', { ...step.event, atNextFrame: true }, runSignal);
        result.queued = true;
      } else if (step.op === 'frames') {
        await session.live.request('step', { frames: step.frames, kind: step.kind }, runSignal);
        result = { ...result, frames: step.frames, kind: step.kind };
      } else if (step.op === 'screenshot') {
        const response = await session.live.request('screenshot', {}, runSignal);
        if (typeof response.image !== 'string')
          throw new Error('Screenshot did not return an image');
        images.push({ type: 'image', mimeType: 'image/png', data: response.image });
        result = {
          ...result,
          imageIndex: images.length - 1,
          width: response.width,
          height: response.height,
        };
      } else {
        const response = await session.live.request(
          'properties',
          { nodePath: step.nodePath, properties: [step.property] },
          runSignal,
        );
        const properties = object(response.properties);
        const actual = object(properties[step.property]).value;
        const passed = compareState(actual, step.expected, step.comparison, step.tolerance);
        result = {
          ...result,
          nodePath: step.nodePath,
          property: step.property,
          comparison: step.comparison,
          expected: step.expected,
          actual,
          passed,
          ...(step.comparison === 'approx' ? { tolerance: step.tolerance } : {}),
        };
      }
      if (Buffer.byteLength(JSON.stringify([...results, result])) > 30000) {
        failure = {
          code: 'OUTPUT_LIMIT',
          error: 'Assertion evidence exceeds 30 KiB; use smaller values or fewer assertions',
        };
        break;
      }
      results.push(result);
    }
  } catch (error) {
    failure = {
      code: timeout.aborted ? 'TIMEOUT' : signal?.aborted ? 'CANCELLED' : 'RUNTIME_ERROR',
      error: String(error).slice(0, 1024),
    };
  } finally {
    // Terminating the owned game releases held inputs, queued events and temporary IPC.
    // If startup never began, validation must not stop an existing game.
    if (attempted) await session.live.close();
    stopped = attempted && !session.game.current?.running;
  }
  signal?.throwIfAborted();
  const snapshot = started ? session.game.current?.snapshot() : undefined;
  if (snapshot?.truncated && !failure)
    failure = {
      code: 'OUTPUT_LIMIT',
      error: 'Game logs were truncated; a clean run cannot be confirmed',
    };
  const allDiagnostics = snapshot
    ? [...parseDiagnostics(snapshot.output), ...parseDiagnostics(snapshot.errors)]
    : [];
  const diagnostics = allDiagnostics
    .slice(0, 20)
    .map((entry) => ({ ...entry, message: entry.message.slice(0, 512) }));
  const counts = diagnosticCounts(allDiagnostics);
  const data = {
    passed:
      !failure &&
      counts.errors === 0 &&
      results.length === steps.length &&
      results.every((step) => step.passed !== false),
    stopped,
    scenePath: scene || null,
    steps: results,
    requestedSteps: steps.length,
    completedSteps: results.length,
    screenshotCount: images.length,
    diagnostics,
    diagnosticsTruncated: allDiagnostics.length > diagnostics.length,
    logsTruncated: snapshot?.truncated ?? false,
    counts,
    output: snapshot?.output.slice(-20).map((line) => line.slice(0, 512)) ?? [],
    ...failure,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }, ...images],
    structuredContent: data,
    isError: !data.passed,
  };
}
