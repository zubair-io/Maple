/**
 * Per-phase wall time for one `GET /api/search` request, reported as a `Server-Timing` header
 * (#4503) so DevTools and `scripts/search-audit.ts` can see where a slow search spent its time
 * without a log query. A phase that runs more than once in a request accumulates; phases that
 * overlap (the page and its count) are each reported in full, so they need not sum to `total`.
 */

export class PhaseTimer {
  private readonly started = performance.now();
  private readonly phases = new Map<string, number>();

  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const began = performance.now();
    try {
      return await work();
    } finally {
      this.phases.set(name, (this.phases.get(name) ?? 0) + performance.now() - began);
    }
  }

  header(): string {
    const entries = [...this.phases, ['total', performance.now() - this.started] as const];
    return entries.map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(', ');
  }
}
