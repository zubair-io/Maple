import { markScopeReadback } from './raw-pipeline.perf';
import { ScopeColorConverter, type WebScopePixels } from './raw-pipeline.scope-colors';
import type { SessionScopeUpdate } from './raw-pipeline.types';

interface ScopeSession {
  readonly colorSpace: string;
  sample_scope(): Promise<WebScopePixels>;
}

interface CaptureState {
  sessionId: number;
  session: ScopeSession;
  colorSpace: string;
  latestRenderId: number;
  queued: boolean;
  inFlight: boolean;
}

/**
 * One owned GPU map at a time, plus the latest successful presentation. A short
 * serialized operation freezes its source buffer, but the map Promise never
 * occupies the render queue. Completion schedules a trailing capture when an
 * edit arrived meanwhile, including the final or only edit of a drag.
 */
export class SessionScopeReadback {
  private current: CaptureState | null = null;
  private readonly colors = new ScopeColorConverter();

  constructor(
    private readonly enqueue: (operation: () => void) => void,
    private readonly publish: (update: SessionScopeUpdate) => void,
  ) {}

  open(sessionId: number, session: ScopeSession): void {
    this.current = {
      sessionId,
      session,
      colorSpace: session.colorSpace,
      latestRenderId: sessionId,
      queued: false,
      inFlight: false,
    };
    this.queue(this.current);
  }

  presented(renderId: number): void {
    if (!this.current) return;
    this.current.latestRenderId = renderId;
    this.queue(this.current);
  }

  close(): void {
    // An outstanding map owns its staging buffer; its eventual completion still
    // frees the WASM result but cannot publish into the replacement session.
    this.current = null;
  }

  private queue(state: CaptureState): void {
    if (this.current !== state || state.queued || state.inFlight) return;
    state.queued = true;
    this.enqueue(() => {
      state.queued = false;
      if (this.current !== state || state.inFlight) return;
      this.capture(state);
    });
  }

  private capture(state: CaptureState): void {
    const renderId = state.latestRenderId;
    state.inFlight = true;
    // Invoke synchronously under sessionChain, releasing wasm-bindgen's borrow
    // as soon as the owned Promise is returned. Do not await it in that chain.
    let pending: Promise<WebScopePixels>;
    try {
      pending = markScopeReadback(renderId, () => state.session.sample_scope());
    } catch (error) {
      this.finished(state, renderId, error);
      return;
    }
    void pending.then(
      (pixels) => {
        try {
          // A completed sample may lag a newer presentation. Publishing the
          // newest available pixels keeps scopes alive during a long drag;
          // the trailing capture still guarantees the final edit arrives.
          if (this.current === state) {
            this.publish({
              id: 0,
              type: 'session-scope',
              sessionId: state.sessionId,
              renderId,
              scope: this.colors.convert(pixels, state.colorSpace),
            });
          }
        } catch (error) {
          console.warn('[raw-pipeline.worker] scope conversion failed:', error);
        } finally {
          pixels.free();
          this.finished(state, renderId);
        }
      },
      (error: unknown) => this.finished(state, renderId, error),
    );
  }

  private finished(state: CaptureState, renderId: number, error?: unknown): void {
    state.inFlight = false;
    if (error) console.warn('[raw-pipeline.worker] asynchronous scope readback failed:', error);
    if (state.latestRenderId > renderId) this.queue(state);
  }
}
