interface Pending<I, O> {
  item: I;
  resolve: (result: O) => void;
  reject: (error: unknown) => void;
}

export interface Batcher<I, O> {
  submit(item: I): Promise<O>;
}

/**
 * Gathers items submitted by concurrent callers into one `run` call. A batch goes out as soon as
 * it is full, or after `lingerMs` when the callers arrive in a trickle.
 */
export function createBatcher<I, O>(
  run: (items: readonly I[]) => Promise<readonly O[]>,
  options: { maxBatch: number; lingerMs: number },
): Batcher<I, O> {
  const state: { pending: Pending<I, O>[]; timer: ReturnType<typeof setTimeout> | null } = {
    pending: [],
    timer: null,
  };

  const settle = async (batch: Pending<I, O>[]): Promise<void> => {
    try {
      const results = await run(batch.map((entry) => entry.item));
      batch.forEach((entry, index) =>
        results[index] === undefined
          ? entry.reject(new Error('batch run returned fewer results than items'))
          : entry.resolve(results[index]),
      );
    } catch (error) {
      batch.forEach((entry) => entry.reject(error));
    }
  };

  const flush = (): void => {
    if (state.timer !== null) clearTimeout(state.timer);
    const batch = state.pending.splice(0, options.maxBatch);
    state.timer = null;
    if (state.pending.length > 0) schedule();
    if (batch.length === 0) return;
    void settle(batch);
  };

  const schedule = (): void => {
    if (state.timer === null) state.timer = setTimeout(flush, options.lingerMs);
  };

  return {
    submit(item) {
      return new Promise<O>((resolve, reject) => {
        state.pending.push({ item, resolve, reject });
        if (state.pending.length >= options.maxBatch) flush();
        else schedule();
      });
    },
  };
}
