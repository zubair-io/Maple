import { Injectable, signal } from '@angular/core';
import { Observable, ReplaySubject } from 'rxjs';
import type { IndexerStatus } from '../api/bun-api-backend.service';

/**
 * IndexerEventsService — live WebSocket subscription to /api/events.
 *
 * The server emits `{ type: "status", status: IndexerStatus, ts: number }`
 * frames on connect and every ~250 ms (alongside per-stage progress frames).
 * This service filters those frames and exposes them as an Observable so the
 * IndexerAdminComponent can stay live without polling.
 */
@Injectable({ providedIn: 'root' })
export class IndexerEventsService {
  private socket: WebSocket | null = null;
  private subject = new ReplaySubject<IndexerStatus | null>(1);
  readonly status$: Observable<IndexerStatus | null> = this.subject.asObservable();
  readonly connected = signal(false);

  connect(): void {
    if (this.socket) return;
    this.socket = new WebSocket(this.endpoint());
    this.socket.onopen = () => this.connected.set(true);
    this.socket.onclose = () => {
      this.connected.set(false);
      this.socket = null;
    };
    this.socket.onerror = () => {
      this.connected.set(false);
    };
    this.socket.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as { type?: string; status?: IndexerStatus };
        if (msg && msg.type === 'status' && msg.status) {
          this.subject.next(msg.status);
        }
      } catch {
        // Ignore malformed frames.
      }
    };
  }

  disconnect(): void {
    if (!this.socket) return;
    try { this.socket.close(); } catch { /* noop */ }
    this.socket = null;
    this.connected.set(false);
  }

  private endpoint(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/events`;
  }
}
