/**
 * Where the compressed output is written.
 *
 * With `BufferTarget` the whole output stays in memory, and wrapping it in a
 * `Blob` copies it once more; a multi-gigabyte input can exhaust the tab's
 * memory. When the Origin Private File System (OPFS) is writable, the output is
 * streamed to disk instead and returned as a disk-backed `File`, so reading,
 * slicing and uploading it costs no extra memory.
 *
 * Each compression owns `browser-video-compression/<id>/` in OPFS and holds a
 * Web Lock with the same id for as long as the result is alive. The files are
 * deleted only when the caller disposes of the result (after the upload has
 * settled), never when compression finishes: deferred uploads and chunk retries
 * read from that file. If the tab closes first, the browser releases the lock
 * and the next compression removes the leftover directory. Directories whose
 * lock is still held belong to another live tab or result and are left alone.
 *
 * Without OPFS or Web Locks (or when OPFS fails), the output is kept in memory,
 * exactly as in 0.1.x, and the result reports `storage: 'memory'`.
 */

import type { BufferTarget, StreamTarget } from 'mediabunny';

export type OutputStorage = 'opfs' | 'memory';

const ROOT_DIR = 'browser-video-compression';
const LOCK_PREFIX = 'browser-video-compression:';

export interface OutputSink {
  target: StreamTarget | BufferTarget;
  storage: OutputStorage;
  /** Call after `output.finalize()`. Returns `null` when nothing was written. */
  finish: (mimeType: string) => Promise<Blob | null>;
  /** Deletes the output and releases the lock. Safe to call more than once. */
  release: () => Promise<void>;
}

export function canUseOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof navigator.locks?.request === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

async function createMemorySink(): Promise<OutputSink> {
  const { BufferTarget } = await import('mediabunny');
  const target = new BufferTarget();
  return {
    target,
    storage: 'memory',
    finish: async (mimeType) =>
      target.buffer ? new Blob([target.buffer], { type: mimeType }) : null,
    release: async () => {},
  };
}

/** Holds a lock until the returned function is called. Lock names are unique, so it is granted at once. */
function holdLock(name: string): Promise<() => void> {
  return new Promise((resolveHeld, rejectHeld) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    navigator.locks
      .request(name, () => {
        resolveHeld(release);
        return released;
      })
      .catch(rejectHeld);
  });
}

async function removeEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (error) {
    if ((error as DOMException)?.name === 'NotFoundError') return;
    console.error('browser-video-compression: failed to remove OPFS entry', {
      name,
      error,
    });
  }
}

/**
 * Removes output directories whose lock is no longer held. Directories are
 * listed before locks are queried: an output always takes its lock before
 * creating its directory, so a listed directory without a lock is abandoned.
 */
async function sweepStale(outputs: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  for await (const name of outputs.keys()) names.push(name);
  if (names.length === 0) return;
  const { held = [] } = await navigator.locks.query();
  const alive = new Set(held.map((lock) => lock.name));
  for (const name of names) {
    if (!alive.has(LOCK_PREFIX + name)) await removeEntry(outputs, name);
  }
}

async function createOpfsSink(fileName: string): Promise<OutputSink> {
  const id = crypto.randomUUID();
  const releaseLock = await holdLock(LOCK_PREFIX + id);
  try {
    const root = await navigator.storage.getDirectory();
    const outputs = await root.getDirectoryHandle(ROOT_DIR, { create: true });
    await sweepStale(outputs);
    const dir = await outputs.getDirectoryHandle(id, { create: true });
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const { StreamTarget } = await import('mediabunny');

    let finished = false;
    let released: Promise<void> | undefined;
    return {
      target: new StreamTarget(writable, { chunked: true }),
      storage: 'opfs',
      finish: async (mimeType) => {
        finished = true;
        return new Blob([await handle.getFile()], { type: mimeType });
      },
      release: () => {
        released ??= (async () => {
          try {
            // Before `output.start()` Mediabunny has not taken the writer, so
            // `output.cancel()` cannot close the stream; abort it here.
            if (!finished && !writable.locked) {
              await writable.abort().catch((error: unknown) => {
                console.error(
                  'browser-video-compression: failed to abort OPFS writable',
                  error,
                );
              });
            }
            await removeEntry(outputs, id);
          } finally {
            releaseLock();
          }
        })();
        return released;
      },
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}

/** Creates the output for one compression, on OPFS when possible and in memory otherwise. */
export async function createOutputSink(
  fileName: string,
  preferred: 'auto' | 'memory',
): Promise<OutputSink> {
  if (preferred === 'memory' || !canUseOpfs()) return createMemorySink();
  try {
    return await createOpfsSink(fileName);
  } catch (error) {
    console.error(
      'browser-video-compression: OPFS output unavailable, keeping the output in memory',
      error,
    );
    return createMemorySink();
  }
}
