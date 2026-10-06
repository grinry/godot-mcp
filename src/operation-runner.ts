import { diagnosticCounts, parseDiagnostics } from './diagnostics.js';
import { GodotProcess } from './godot-process.js';

/** Own every finite child until its pipes close, including during cancellation/shutdown. */
export class OperationRunner {
  private readonly active = new Set<GodotProcess>();
  private readonly pending = new Set<Promise<GodotProcess>>();
  private closed = false;

  async run(command: string, args: string[], timeoutMs = 60000, signal?: AbortSignal) {
    if (this.closed) throw new Error('Server is shutting down');
    signal?.throwIfAborted();
    const starting = GodotProcess.start(command, args, timeoutMs);
    this.pending.add(starting);
    let child: GodotProcess;
    try {
      child = await starting;
      this.active.add(child);
    } finally {
      this.pending.delete(starting);
    }
    const abort = () => void child.stop().catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (this.closed || signal?.aborted) await child.stop();
      await child.done;
      signal?.throwIfAborted();
      if (this.closed) throw new Error('Server is shutting down');
      return child;
    } finally {
      signal?.removeEventListener('abort', abort);
      await child.stop();
      this.active.delete(child);
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.active].map((child) => child.stop()));
  }
}

export function processDiagnostics(child: GodotProcess) {
  return [...parseDiagnostics(child.output), ...parseDiagnostics(child.errors)];
}

export function processReport(child: GodotProcess) {
  const diagnostics = processDiagnostics(child);
  return { ...child.snapshot(), diagnostics, counts: diagnosticCounts(diagnostics) };
}

export function requireSuccess(child: GodotProcess) {
  const errors = processDiagnostics(child);
  if (
    child.exitCode !== 0 ||
    child.timedOut ||
    child.truncated ||
    errors.some((item) => item.severity === 'error')
  ) {
    throw new Error(JSON.stringify(processReport(child)));
  }
  return { stdout: child.output.join('\n'), stderr: child.errors.join('\n') };
}
