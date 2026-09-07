import { BehaviorSubject } from 'rxjs';
import type { DecodedImage, SessionScopeUpdate } from './raw-pipeline.types';

/** Reject late scopes independently of the already settled render request. */
export class LiveScopeClient {
  readonly pixels = new BehaviorSubject<DecodedImage | null>(null);
  private sessionId: number | null = null;
  private requestedId = 0;
  private publishedId = 0;

  open(id: number): void {
    this.sessionId = id;
    this.requestedId = id;
    this.publishedId = 0;
    this.pixels.next(null);
  }

  requested(id: number): void {
    this.requestedId = id;
  }

  close(): void {
    this.sessionId = null;
    this.pixels.next(null);
  }

  accept(update: SessionScopeUpdate): void {
    if (
      update.sessionId !== this.sessionId ||
      update.renderId > this.requestedId ||
      update.renderId <= this.publishedId
    )
      return;
    this.publishedId = update.renderId;
    this.pixels.next({
      width: update.scope.width,
      height: update.scope.height,
      rgb: new Uint8Array(update.scope.rgb),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
  }
}
