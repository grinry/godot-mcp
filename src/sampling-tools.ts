import { isDeepStrictEqual } from 'node:util';
import { nodePath } from './authoring-tools.js';
import type { GodotSession } from './godot-session.js';
import type { ToolSpecification } from './tool-types.js';

export const performanceMonitorNames = [
  'fps',
  'processTime',
  'physicsTime',
  'staticMemory',
  'nodeCount',
  'objectCount',
  'resourceCount',
  'orphanNodeCount',
  'drawCalls',
  'renderedObjects',
  'videoMemory',
  'textureMemory',
  'physics2dObjects',
  'physics3dObjects',
];
const string = { type: 'string' };
export const samplingTools: ToolSpecification[] = [
  'sample_performance',
  'sample_node_properties',
].map((name) => ({
  name,
  session: 'use',
  access: 'execute',
  description:
    name === 'sample_performance'
      ? 'Sample selected runtime Performance monitors across stepped frames in a paused debug session. Returns bounded series, units and numeric summaries. Advances the game and leaves it paused; not passive/full profiling.'
      : 'Sample 1–10 named properties on a live node across stepped frames in a paused debug session. Returns bounded typed values and numeric/vector component summaries. Executes getters, advances the game and leaves it paused.',
  inputSchema: {
    type: 'object',
    properties: {
      samples: { type: 'integer', minimum: 2, maximum: 120, default: 30 },
      intervalFrames: { type: 'integer', minimum: 1, maximum: 120, default: 1 },
      kind: { type: 'string', enum: ['physics', 'process'], default: 'physics' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, default: 60000 },
      ...(name === 'sample_performance'
        ? {
            monitors: {
              type: 'array',
              minItems: 1,
              maxItems: performanceMonitorNames.length,
              items: { type: 'string', enum: performanceMonitorNames },
            },
          }
        : {
            nodePath: string,
            properties: { type: 'array', minItems: 1, maxItems: 10, items: string },
          }),
    },
    required: name === 'sample_node_properties' ? ['nodePath', 'properties'] : [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      samples: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sampledAtMs: { type: 'number' },
            processFrame: { type: 'number' },
            physicsFrame: { type: 'number' },
            values: { type: 'object' },
          },
          required: ['sampledAtMs', 'processFrame', 'physicsFrame', 'values'],
        },
      },
      summaries: { type: 'object' },
      metrics: { type: 'array', items: { type: 'object' } },
      sampleCount: { type: 'integer' },
      intervalFrames: { type: 'integer' },
      advancedFrames: { type: 'integer' },
      paused: { type: 'boolean' },
      kind: string,
    },
    required: [
      'samples',
      'summaries',
      'sampleCount',
      'intervalFrames',
      'advancedFrames',
      'paused',
      'kind',
    ],
  },
}));

/** Reject malformed/oversized sampling before sending a frame-changing request. */
export function samplingParameters(name: string, args: Record<string, unknown>) {
  const integer = (value: unknown, min: number, max: number, label: string) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${label}`);
    return value;
  };
  const samples = integer(args.samples ?? 30, 2, 120, 'samples');
  const intervalFrames = integer(args.intervalFrames ?? 1, 1, 120, 'intervalFrames');
  if ((samples - 1) * intervalFrames > 1200)
    throw new Error('Sampling is limited to 1200 advanced frames');
  const kind = args.kind ?? 'physics';
  if (kind !== 'physics' && kind !== 'process') throw new Error('kind must be physics or process');
  const timeoutMs = integer(args.timeoutMs ?? 60000, 1, 600000, 'timeoutMs');
  const params: Record<string, unknown> = {
    samples,
    intervalFrames,
    kind,
    source: name === 'sample_performance' ? 'performance' : 'properties',
  };
  const selection =
    name === 'sample_performance' ? (args.monitors ?? performanceMonitorNames) : args.properties;
  const max = name === 'sample_performance' ? performanceMonitorNames.length : 10;
  if (
    !Array.isArray(selection) ||
    selection.length < 1 ||
    selection.length > max ||
    new Set(selection).size !== selection.length ||
    selection.some(
      (key) => typeof key !== 'string' || !key || key.length > 128 || key.includes('\0'),
    )
  )
    throw new Error('Invalid or duplicate sampling fields');
  if (name === 'sample_performance') {
    if (selection.some((key) => !performanceMonitorNames.includes(key)))
      throw new Error('Unknown performance monitor');
    params.monitors = selection;
  } else {
    params.properties = selection;
    params.nodePath = nodePath(args.nodePath);
  }
  return { params, timeoutMs };
}

/** Numeric summaries use nearest-rank percentiles and unweighted sample means. */
export function numericSummary(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new Error('Numeric summaries require finite samples');
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value / values.length, 0);
  const delta = values[values.length - 1] - values[0];
  return {
    kind: 'numeric',
    count: values.length,
    min: sorted[0],
    max: sorted.at(-1),
    mean: Number.isFinite(mean) ? mean : null,
    p50: sorted[Math.ceil(values.length * 0.5) - 1],
    p95: sorted[Math.ceil(values.length * 0.95) - 1],
    first: values[0],
    last: values.at(-1),
    delta: Number.isFinite(delta) ? delta : null,
    ...(!Number.isFinite(mean) || !Number.isFinite(delta) ? { arithmeticOverflow: true } : {}),
  };
}

export function summarizeSeries(values: unknown[]): Record<string, unknown> {
  if (values.every((value) => value === null)) return { kind: 'unavailable', count: 0 };
  if (values.every((value): value is number => typeof value === 'number' && Number.isFinite(value)))
    return numericSummary(values);
  const first = values[0];
  const labels: Record<string, string[]> = {
    Vector2: ['x', 'y'],
    Vector2i: ['x', 'y'],
    Vector3: ['x', 'y', 'z'],
    Vector3i: ['x', 'y', 'z'],
    Vector4: ['x', 'y', 'z', 'w'],
    Vector4i: ['x', 'y', 'z', 'w'],
    Quaternion: ['x', 'y', 'z', 'w'],
    Color: ['r', 'g', 'b', 'a'],
  };
  if (
    first &&
    typeof first === 'object' &&
    'type' in first &&
    typeof first.type === 'string' &&
    labels[first.type]
  ) {
    const components = labels[first.type];
    const rows = values.map((value) =>
      value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === first.type &&
      'value' in value &&
      Array.isArray(value.value)
        ? value.value
        : [],
    );
    if (
      rows.every(
        (row) =>
          row.length === components.length &&
          row.every((value) => typeof value === 'number' && Number.isFinite(value)),
      )
    )
      return {
        kind: 'components',
        type: first.type,
        components: Object.fromEntries(
          components.map((label, index) => [label, numericSummary(rows.map((row) => row[index]))]),
        ),
      };
  }
  return {
    kind: 'nonNumeric',
    count: values.length,
    changes: values.slice(1).filter((value, index) => !isDeepStrictEqual(value, values[index]))
      .length,
  };
}

/** Sampling uses the existing session lifecycle and global deadline/IPC cleanup. */
export async function handleSamplingTool(
  name: string,
  args: Record<string, unknown>,
  session: GodotSession,
  signal?: AbortSignal,
) {
  const { params, timeoutMs } = samplingParameters(name, args);
  const timeout = AbortSignal.timeout(timeoutMs);
  const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await session.live.request('sample', params, runSignal, timeoutMs);
  if (!Array.isArray(response.samples)) throw new Error('Bridge did not return sample evidence');
  const samples = response.samples as { values: Record<string, unknown> }[];
  const keys = name === 'sample_performance' ? params.monitors : params.properties;
  if (!Array.isArray(keys) || samples.length !== params.samples)
    throw new Error('Incomplete sample evidence');
  const summaries = Object.fromEntries(
    keys.map((key) => [key, summarizeSeries(samples.map((sample) => sample.values[key]))]),
  );
  const data = {
    ...response,
    source: params.source,
    ...(params.nodePath !== undefined ? { nodePath: params.nodePath } : {}),
    summaries,
  };
  if (Buffer.byteLength(JSON.stringify(data)) > 60000)
    throw new Error('Sampling result exceeds 60 KiB; reduce fields/samples');
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
