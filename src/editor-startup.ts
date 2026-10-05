import { setTimeout as delay } from 'node:timers/promises';
import type { GodotProcess } from './godot-process.js';
import { processDiagnostics } from './operation-runner.js';

/** Observe early exits/errors; this is not a promise that project loading has finished. */
export async function observeEditorStartup(
  child: GodotProcess,
  signal?: AbortSignal,
  windowMs = 1500,
) {
  try {
    await Promise.race([child.done, delay(windowMs, undefined, { signal })]);
    signal?.throwIfAborted();
    const diagnostics = processDiagnostics(child);
    if (!child.running || diagnostics.length || child.truncated) {
      throw new Error(JSON.stringify({ ...child.snapshot(), diagnostics }));
    }
    return { started: true, startupObservationMs: windowMs, ...child.snapshot() };
  } catch (error) {
    await child.stop();
    throw error;
  }
}
