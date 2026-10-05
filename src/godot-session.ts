import { ProcessSlot } from './godot-process.js';
import { LiveSession } from './live-session.js';

/** Serializes session requests; closure permanently prevents queued launches. */
export class GodotSession {
  readonly game = new ProcessSlot();
  readonly editor = new ProcessSlot();
  readonly live = new LiveSession(this.game);
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('Session is closed');
      const value = await operation();
      if (this.closed) throw new Error('Session is closed');
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Mark slots closed synchronously before draining accepted requests.
    const children = Promise.all([this.game.shutdown(), this.editor.shutdown(), this.live.close()]);
    this.closing = Promise.allSettled([children, this.queue]).then(async (results) => {
      // A running request may have been allocating live IPC when closure began.
      await this.live.close();
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    return this.closing;
  }
}
