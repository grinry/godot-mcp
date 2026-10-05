import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

export class GodotProcess {
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly done: Promise<void>;
  exitCode: number | null = null;
  signal: string | null = null;
  timedOut = false;
  running = true;
  private child: ChildProcess;
  private timer?: NodeJS.Timeout;
  private bytes = 0;
  private stopping?: Promise<void>;
  truncated = false;

  private constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const attach = (stream: NodeJS.ReadableStream | null, lines: string[]) => {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      stream?.on('data', (chunk: Buffer) => {
        // Bound memory even for a child that emits no newlines.
        const allowed = Math.max(0, 1024 * 1024 - this.bytes);
        this.bytes += Math.min(allowed, chunk.length);
        if (chunk.length > allowed) this.truncated = true;
        if (allowed === 0) return;
        pending += decoder.write(chunk.subarray(0, allowed));
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        const available = Math.max(0, 10000 - lines.length);
        if (parts.length > available) this.truncated = true;
        lines.push(...parts.slice(0, available));
      });
      stream?.on('end', () => {
        pending += decoder.end();
        if (pending && lines.length < 10000) lines.push(pending);
        else if (pending) this.truncated = true;
      });
    };
    attach(this.child.stdout, this.output);
    attach(this.child.stderr, this.errors);
    this.done = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.running = false;
        this.exitCode = code;
        this.signal = signal;
        clearTimeout(this.timer);
        resolve();
        // Clean residual descendants immediately, before the retained PID could be reused.
        if (process.platform !== 'win32')
          void this.stop().catch((error: unknown) => this.errors.push(String(error)));
      });
    });
    // Prevent an unhandled error; start() also rejects with the same error.
    this.child.on('error', (error) => this.errors.push(error.message));
  }

  static async start(command: string, args: string[], timeoutMs?: number) {
    const instance = new GodotProcess(command, args);
    await new Promise<void>((resolve, reject) => {
      instance.child.once('spawn', resolve);
      instance.child.once('error', reject);
    });
    if (timeoutMs && instance.running) {
      instance.timer = setTimeout(() => {
        instance.timedOut = true;
        void instance.stop().catch((error: unknown) => {
          instance.errors.push(String(error));
        });
      }, timeoutMs);
    }
    return instance;
  }

  private sendSignal(signal: NodeJS.Signals) {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ESRCH') return;
        // macOS can reject a group signal while the child is still starting or exiting.
        if (error.code === 'EPERM') {
          this.child.kill(signal);
          return;
        }
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopOwnedProcess();
    return this.stopping;
  }

  private groupRunning() {
    if (process.platform === 'win32' || !this.child.pid) return this.running;
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ESRCH') return false;
        if (error.code === 'EPERM') return this.running;
      }
      throw error;
    }
  }

  private async stopOwnedProcess() {
    if (!this.running && !this.groupRunning()) return;
    clearTimeout(this.timer);
    if (process.platform === 'win32' && this.child.pid) {
      await new Promise<void>((resolve) => {
        execFile(
          'taskkill.exe',
          ['/PID', String(this.child.pid), '/T', '/F'],
          { timeout: 3000, maxBuffer: 65536, windowsHide: true },
          (error) => {
            if (error && this.running) this.child.kill('SIGTERM');
            resolve();
          },
        );
      });
    } else this.sendSignal('SIGTERM');
    const finishedWithin = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (this.running || this.groupRunning()) {
        if (Date.now() >= deadline) return false;
        await delay(20);
      }
      return true;
    };
    if (await finishedWithin(1000)) return;
    this.sendSignal('SIGKILL');
    if (!(await finishedWithin(3000))) throw new Error('Godot did not terminate after SIGKILL');
  }

  snapshot() {
    return {
      output: this.output,
      errors: this.errors,
      running: this.running,
      exitCode: this.exitCode,
      signal: this.signal,
      timedOut: this.timedOut,
      truncated: this.truncated,
    };
  }
}

// Serialize launch/replace/stop operations. A failed operation never poisons the queue.
export class ProcessSlot {
  current: GodotProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  start(command: string, args: string[], timeoutMs?: number) {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('Process slot is closed');
      await this.current?.stop();
      if (this.closed) throw new Error('Process slot is closed');
      this.current = await GodotProcess.start(command, args, timeoutMs);
      if (this.closed) {
        await this.current.stop();
        throw new Error('Process slot is closed');
      }
      return this.current;
    });
  }
  shutdown() {
    this.closed = true;
    return this.stop();
  }
  stop() {
    return this.enqueue(async () => {
      await this.current?.stop();
      return this.current;
    });
  }
}
