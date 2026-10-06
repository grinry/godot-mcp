import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { GodotProcess, ProcessSlot } from './godot-process.js';

// Private file IPC avoids installing addons/autoloads and exposes no network listener.
export class LiveSession {
  private directory?: string;
  private token?: string;
  private child?: GodotProcess;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly slot: ProcessSlot) {}
  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async clear() {
    await this.child?.stop();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.token = undefined;
    this.child = undefined;
  }
  close() {
    return this.enqueue(() => this.clear());
  }
  async start(
    godot: string,
    root: string,
    script: string,
    scene: string,
    headless: boolean,
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.clear();
      this.directory = await mkdtemp(join(tmpdir(), 'godot-mcp-live-'));
      this.token = randomUUID();
      try {
        const config = join(this.directory, 'config.json');
        await writeFile(config, JSON.stringify({ token: this.token, scene }), { mode: 0o600 });
        this.child = await this.slot.start(godot, [
          ...(headless ? ['--headless'] : []),
          '--path',
          root,
          '--script',
          script,
          '--',
          config,
        ]);
        const ready = await this.waitFor(join(this.directory, 'ready.json'), 15000, signal);
        if (ready.ok !== true)
          throw new Error(String(ready.error ?? 'Live session initialization failed'));
        return { running: true, scene: ready.scene, headless };
      } catch (error) {
        await this.clear();
        throw error;
      }
    });
  }
  private async waitFor(
    path: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!this.child?.running || this.child !== this.slot.current)
        throw new Error('Debug session is no longer running');
      const size = await stat(path).catch(() => null);
      if (size) {
        if (size.size > 65536) throw new Error('Bridge response exceeds limit');
        return JSON.parse(await readFile(path, 'utf8'));
      }
      await delay(20, undefined, { signal });
    }
    throw new Error('Debug session request timed out');
  }
  request(
    operation: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 10000,
  ) {
    return this.enqueue(async () => {
      if (!this.directory || !this.token) throw new Error('Start a debug session first');
      const directory = this.directory;
      const id = randomUUID();
      const responsePath = join(directory, `response-${id}.json`);
      const screenshotPath = join(directory, `capture-${id}.png`);
      try {
        const temporary = join(directory, 'request.tmp');
        await writeFile(temporary, JSON.stringify({ id, token: this.token, operation, params }), {
          mode: 0o600,
        });
        await rename(temporary, join(directory, 'request.json'));
        const response = await this.waitFor(responsePath, timeoutMs, signal);
        if (response.id !== id) throw new Error('Bridge response ID mismatch');
        if (response.ok !== true) throw new Error(String(response.error ?? 'Debug request failed'));
        if (operation !== 'screenshot') return response;
        const size = (await stat(screenshotPath)).size;
        if (size > 8 * 1024 * 1024) throw new Error('Screenshot exceeds 8 MiB');
        return { ...response, image: (await readFile(screenshotPath)).toString('base64') };
      } catch (error) {
        // A timeout/cancellation must not leave a request executing against a future session.
        if (signal?.aborted || !this.child?.running || String(error).includes('timed out'))
          await this.clear();
        throw error;
      } finally {
        await Promise.all([rm(responsePath, { force: true }), rm(screenshotPath, { force: true })]);
      }
    });
  }
}
