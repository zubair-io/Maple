import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Subscription } from 'rxjs';
import { WorkerEventsService, type WorkersStatusUpdate } from './worker-events.service';
import { API_BASE_URL } from './api-base-url.token';
import { AuthService } from '../auth/auth.service';
import type { WorkersStatusResponse } from './workers-api.service';

// ── Minimal fake WebSocket ──────────────────────────────────────────────────
// Captures the URL, lets the test drive onmessage/onopen/onclose.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const STATUS: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      inFlight: 1,
      configured: 2,
      pending: 10,
      ready: 9,
      blocked: 1,
      dead: 0,
      throughput: 5,
      lastError: null,
      config: null,
      batchSize: 10,
    },
  ],
};

describe('WorkerEventsService', () => {
  let svc: WorkerEventsService;
  let origWs: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    origWs = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket =
      FakeWebSocket as unknown as typeof globalThis.WebSocket;

    TestBed.configureTestingModule({
      providers: [
        WorkerEventsService,
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: AuthService, useValue: { bearer: 'tok-123' } as Partial<AuthService> },
      ],
    });
    svc = TestBed.inject(WorkerEventsService);
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWs;
  });

  it('opens a tokenless /api/events ws and sends an auth frame on open (#863)', () => {
    const sub = svc.workersStatus$.subscribe();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain('/api/events');
    expect(ws.url).toMatch(/^ws/);
    expect(ws.url).not.toContain('token'); // token is no longer in the URL
    // It authenticates with a post-connect frame instead.
    ws.onopen?.();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'auth', token: 'tok-123' });
    sub.unsubscribe();
  });

  it('emits the status payload + counted flag from a workers-status frame', () => {
    const seen: WorkersStatusUpdate[] = [];
    const sub = svc.workersStatus$.subscribe((s) => seen.push(s));
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: 'workers-status', status: STATUS, counted: true, ts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0].counted).toBe(true);
    expect(seen[0].status.stages[0].name).toBe('hash');
    expect(seen[0].status.stages[0].pending).toBe(10);
    sub.unsubscribe();
  });

  it('preserves counted:false for the cheap registry-only snapshot', () => {
    const seen: WorkersStatusUpdate[] = [];
    const sub = svc.workersStatus$.subscribe((s) => seen.push(s));
    const ws = FakeWebSocket.instances[0];
    // Server's initial uncounted frame: zeroed counts, config:null.
    ws.emit({ type: 'workers-status', status: STATUS, counted: false, ts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0].counted).toBe(false);
    sub.unsubscribe();
  });

  it('defaults counted to false when the flag is absent', () => {
    const seen: WorkersStatusUpdate[] = [];
    const sub = svc.workersStatus$.subscribe((s) => seen.push(s));
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: 'workers-status', status: STATUS, ts: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0].counted).toBe(false);
    sub.unsubscribe();
  });

  it('ignores non workers-status frames (process / progress / status)', () => {
    const seen: WorkersStatusUpdate[] = [];
    const sub = svc.workersStatus$.subscribe((s) => seen.push(s));
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: 'process', state: {} });
    ws.emit({ type: 'progress', stage: 'hash', inFlight: 1 });
    ws.emit({ type: 'status', status: {}, ts: 1 });
    expect(seen).toHaveLength(0);
    sub.unsubscribe();
  });

  it('closes the socket on unsubscribe', () => {
    const sub: Subscription = svc.workersStatus$.subscribe();
    const ws = FakeWebSocket.instances[0];
    expect(ws.closed).toBe(false);
    sub.unsubscribe();
    expect(ws.closed).toBe(true);
  });

  it('reconnects after the socket closes unexpectedly', () => {
    vi.useFakeTimers();
    try {
      const sub = svc.workersStatus$.subscribe();
      const first = FakeWebSocket.instances[0];
      // Simulate the server dropping the connection.
      first.onclose?.();
      // The reconnect is scheduled on a backoff timer.
      vi.advanceTimersByTime(1_000);
      expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
      sub.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
