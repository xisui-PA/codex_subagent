import { WorkerError } from './types';

/** Bound provider operations even when a provider ignores cancellation. */
export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => reject(signal.reason || new WorkerError('cancelled', 'Operation cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel)).catch(() => undefined);
    if (signal.aborted) {
      cancel();
    }
  });
}
