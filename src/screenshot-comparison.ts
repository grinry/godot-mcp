import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OperationRunner, requireSuccess } from './operation-runner.js';
import { projectFile } from './project-paths.js';

const maxBytes = 8 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Bound compressed input and decoded allocation before asking Godot to decode it. */
export function pngDimensions(bytes: Buffer) {
  if (bytes.length > maxBytes) throw new Error('PNG exceeds 8 MiB');
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Expected a PNG with a valid IHDR header');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4_000_000)
    throw new Error('PNG dimensions exceed limits (4096 per axis, 4 million pixels)');
  return { width, height };
}

async function readPng(path: string) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > maxBytes) throw new Error('PNG exceeds 8 MiB');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    pngDimensions(bytes);
    return bytes;
  } finally {
    await file.close();
  }
}

export interface VisualAssertion {
  op: 'compare_screenshot';
  baselinePath: string;
  pixelTolerance: number;
  maxChangedRatio: number;
}

/** Decode/compare in an owned isolated engine; never execute the project's autoloads. */
export class ScreenshotComparison {
  private readonly baselines = new Map<string, { path: string; resource: string; hash: string }>();

  private constructor(
    private readonly directory: string,
    private readonly godot: string,
    private readonly scripts: string,
    private readonly runner: OperationRunner,
  ) {}

  static async prepare(
    steps: VisualAssertion[],
    root: string,
    godot: string,
    scripts: string,
    runner: OperationRunner,
    signal?: AbortSignal,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'godot-mcp-visual-'));
    const comparison = new ScreenshotComparison(directory, godot, scripts, runner);
    try {
      for (const step of steps) {
        signal?.throwIfAborted();
        if (comparison.baselines.has(step.baselinePath)) continue;
        const file = await projectFile(root, step.baselinePath, ['.png']);
        const bytes = await readPng(file.path);
        const path = join(directory, `baseline-${comparison.baselines.size}.png`);
        await writeFile(path, bytes, { mode: 0o600 });
        comparison.baselines.set(step.baselinePath, {
          path,
          resource: file.resource,
          hash: createHash('sha256').update(bytes).digest('hex'),
        });
      }
      await comparison.run(
        'validate',
        { paths: [...comparison.baselines.values()].map((b) => b.path) },
        signal,
      );
      return comparison;
    } catch (error) {
      await comparison.close();
      throw error;
    }
  }

  private async run(operation: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const child = await this.runner.run(
      this.godot,
      [
        '--headless',
        '--path',
        this.directory,
        '--script',
        join(this.scripts, 'screenshot_comparison.gd'),
        '--',
        operation,
        JSON.stringify(params),
      ],
      60000,
      signal,
    );
    requireSuccess(child);
    const line = child.output.find((item) => item.startsWith('GODOT_MCP_RESULT '));
    if (!line) throw new Error('Godot did not return a screenshot comparison');
    return JSON.parse(line.slice('GODOT_MCP_RESULT '.length)) as Record<string, unknown>;
  }

  async compare(step: VisualAssertion, image: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const baseline = this.baselines.get(step.baselinePath);
    if (!baseline) throw new Error('Baseline was not prepared');
    const bytes = Buffer.from(image, 'base64');
    pngDimensions(bytes);
    const actualPath = join(this.directory, 'actual.png');
    const diffPath = join(this.directory, 'diff.png');
    await writeFile(actualPath, bytes, { mode: 0o600 });
    const result = await this.run(
      'compare',
      {
        baselinePath: baseline.path,
        actualPath,
        diffPath,
        pixelTolerance: step.pixelTolerance,
        maxChangedRatio: step.maxChangedRatio,
      },
      signal,
    );
    signal?.throwIfAborted();
    const diff = result.code ? undefined : (await readPng(diffPath)).toString('base64');
    return {
      result: {
        ...result,
        baselinePath: baseline.resource,
        baselineHash: baseline.hash,
        pixelTolerance: step.pixelTolerance,
        maxChangedRatio: step.maxChangedRatio,
      },
      diff,
    };
  }

  close() {
    return rm(this.directory, { recursive: true, force: true });
  }
}
