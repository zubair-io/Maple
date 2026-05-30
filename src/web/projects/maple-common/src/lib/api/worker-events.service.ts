// WorkerEventsService — WebSocket stream of worker-pipeline status (#674).
//
// Replaces the Workers settings page's `GET /api/workers/status` HTTP polling
// with the `/api/events` WS bridge. The server pushes a `workers-status` frame
// (cheap registry fields immediately on connect; the expensive pending/ready/
// blocked/dead counts on a single shared ~2s timer, broadcast once to all
// subscribers). `GET /status` stays as a non-WS fallback.
//
// Observable at the service layer per project convention; the component maps it
// into its view-model signals. The socket is reference-counted: it opens on the
// first subscriber and closes when the last unsubscribes.

import { Injectable, inject } from '@angular/core';
import { Observable, Subscriber } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import { AuthService } from '../auth/auth.service';
import type { WorkersStatusResponse } from './workers-api.service';

/** The `workers-status` frame the API emits over `/api/events`. */
interface WorkersStatusFrame {
  type: 'workers-status';
  status: WorkersStatusResponse;
  counted: boolean;
  ts: number;
}

function isWorkersStatusFrame(value: unknown): value is WorkersStatusFrame {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'workers-status' &&
    !!(value as { status?: unknown }).status
  );
}

/**
 * What `workersStatus$` emits. Carries the server's `counted` flag through to
 * consumers: `false` is the cheap registry-only snapshot pushed on connect
 * (zeroed counts, `config:null`), `true` once a DB-counted tick lands. The
 * Workers component uses this so a registry-only frame doesn't pre-empt the
 * HTTP fallback that carries real counts + per-stage config (#674 review).
 */
export interface WorkersStatusUpdate {
  status: WorkersStatusResponse;
  counted: boolean;
}

@Injectable({ providedIn: 'root' })
export class WorkerEventsService {
  private readonly base = inject(API_BASE_URL);
  private readonly auth = inject(AuthService);

  /** Backoff schedule (ms) for reconnect attempts; saturates at the last entry. */
  private static readonly RECONNECT_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

  /**
   * Stream of worker-pipeline status frames. Cold + multicast-free: each
   * subscription owns its own socket. The component subscribes exactly once,
   * so this keeps the implementation simple and avoids a shared-socket
   * lifecycle. Emits `WorkersStatusUpdate` ({@link WorkersStatusUpdate}) —
   * the frame's `status` plus its `counted` flag — including the immediate
   * cheap (uncounted) snapshot on connect.
   */
  readonly workersStatus$: Observable<WorkersStatusUpdate> = new Observable((subscriber) => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closedByUs = false;

    const connect = (): void => {
      if (closedByUs) return;
      const url = this.socketUrl();
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        attempts = 0;
      };
      socket.onmessage = (ev) => this.handleMessage(ev, subscriber);
      socket.onclose = () => {
        socket = null;
        scheduleReconnect();
      };
      socket.onerror = () => {
        // `onclose` fires after `onerror`; let it drive the reconnect so we
        // don't double-schedule.
        try {
          socket?.close();
        } catch {
          /* already closing */
        }
      };
    };

    const scheduleReconnect = (): void => {
      if (closedByUs || reconnectTimer !== null) return;
      const idx = Math.min(attempts, WorkerEventsService.RECONNECT_MS.length - 1);
      attempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, WorkerEventsService.RECONNECT_MS[idx]);
    };

    connect();

    return () => {
      closedByUs = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        socket = null;
      }
    };
  });

  private handleMessage(ev: MessageEvent, subscriber: Subscriber<WorkersStatusUpdate>): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return; // Non-JSON / non-status frames (e.g. process/progress) are ignored.
    }
    if (isWorkersStatusFrame(parsed)) {
      // Preserve `counted`: consumers must distinguish the cheap registry-only
      // snapshot from a DB-counted frame so the HTTP fallback isn't disabled by
      // a registry-only push.
      subscriber.next({ status: parsed.status, counted: parsed.counted === true });
    }
  }

  /**
   * Resolve the `/api/events` WebSocket URL. The browser `WebSocket` ctor can't
   * send an Authorization header, so the access token rides as a query param
   * (the server validates it in `beforeHandle`). Handles both absolute and
   * `/api`-relative base URLs.
   */
  private socketUrl(): string {
    const token = this.auth.bearer ?? '';
    const httpUrl = new URL(`${this.base}/events`, this.origin());
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    if (token) httpUrl.searchParams.set('token', token);
    return httpUrl.toString();
  }

  private origin(): string {
    return typeof window !== 'undefined' && window.location
      ? window.location.origin
      : 'http://localhost';
  }
}
