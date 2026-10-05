import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
  truncated = false;

  private constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

  async stop() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.child.kill('SIGTERM');
    const finishedWithin = async (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          this.done.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (await finishedWithin(1000)) return;
    this.child.kill('SIGKILL');
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
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  start(command: string, args: string[], timeoutMs?: number) {
    return this.enqueue(async () => {
      await this.current?.stop();
      this.current = await GodotProcess.start(command, args, timeoutMs);
      return this.current;
    });
  }
  stop() {
    return this.enqueue(async () => {
      await this.current?.stop();
      return this.current;
    });
  }
}
