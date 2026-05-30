// MapleErrorHandler — Angular global `ErrorHandler` that forwards uncaught
// errors to SigNoz via `ObservabilityService.recordError(...)` while preserving
// the default `console.error` behaviour developers rely on.
//
// Provided in `app.config.ts` as `{ provide: ErrorHandler, useClass: MapleErrorHandler }`.
//
// Recursion guard: if recording an error itself throws (e.g. the OTel exporter
// blows up), we must not loop back through this handler. A re-entrancy flag
// swallows the secondary failure after a single console line.

import { ErrorHandler, Injectable, inject } from '@angular/core';
import { ObservabilityService } from './observability.service';

@Injectable()
export class MapleErrorHandler implements ErrorHandler {
  private readonly observability = inject(ObservabilityService);
  private reentrant = false;

  handleError(error: unknown): void {
    // Always preserve the platform default — devs (and the browser console)
    // expect uncaught errors to show up here regardless of telemetry state.
    console.error(error);

    if (this.reentrant) return;
    this.reentrant = true;
    try {
      this.observability.recordError(error, { 'maple.handler': 'angular-error-handler' });
    } catch (forwardErr) {
      // Telemetry must never escalate an app error into a crash loop.
      console.error('[observability] failed to record error', forwardErr);
    } finally {
      this.reentrant = false;
    }
  }
}
