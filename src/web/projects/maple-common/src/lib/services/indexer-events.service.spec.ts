import { TestBed } from '@angular/core/testing';
import { IndexerEventsService } from './indexer-events.service';

describe('IndexerEventsService', () => {
  let service: IndexerEventsService;
  let originalWS: typeof WebSocket;

  interface FakeSocket {
    onopen: ((e: Event) => void) | null;
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: ((e: Event) => void) | null;
    onclose: ((e: CloseEvent) => void) | null;
    sent: string[];
    closed: boolean;
    url: string;
  }

  const sockets: FakeSocket[] = [];

  class FakeSocketImpl implements FakeSocket {
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    sent: string[] = [];
    closed = false;
    constructor(public url: string) { sockets.push(this); }
    send(msg: string) { this.sent.push(msg); }
    close() { this.closed = true; this.onclose?.(new CloseEvent('close')); }
  }

  beforeEach(() => {
    sockets.length = 0;
    originalWS = globalThis.WebSocket;
    (globalThis as Record<string, unknown>)['WebSocket'] = FakeSocketImpl;
    TestBed.configureTestingModule({});
    service = TestBed.inject(IndexerEventsService);
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>)['WebSocket'] = originalWS;
  });

  it('connects on first connect() call and exposes status$ updates', async () => {
    service.connect();
    expect(sockets.length).toBe(1);

    // Collect the first emitted status via a Promise.
    const statusPromise = new Promise<{ paused: boolean }>((resolve) => {
      const sub = service.status$.subscribe((s) => {
        if (s) {
          sub.unsubscribe();
          resolve(s);
        }
      });
    });

    sockets[0].onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'status',
        status: {
          paused: false,
          pools: { discover: 4, hash: 2, exif: 4, thumb: 2, ai: 1, mongo: 8 },
          channels: {
            discover: { depth: 0, capacity: 256 },
            hash: { depth: 0, capacity: 256 },
            exif: { depth: 0, capacity: 256 },
            thumb: { depth: 0, capacity: 128 },
            ai: { depth: 0, capacity: 256 },
            mongo: { depth: 0, capacity: 256 },
          },
          stages: {
            discover: { inFlight: 0, errors: 0, deadLetter: 0 },
            hash: { inFlight: 0, errors: 0, deadLetter: 0 },
            exif: { inFlight: 0, errors: 0, deadLetter: 0 },
            thumb: { inFlight: 0, errors: 0, deadLetter: 0 },
            ai: { inFlight: 0, errors: 0, deadLetter: 0 },
            mongo: { inFlight: 0, errors: 0, deadLetter: 0 },
          },
        },
        ts: Date.now(),
      }),
    }));

    const received = await statusPromise;
    expect(received.paused).toBe(false);
    service.disconnect();
  });

  it('disconnect() closes the socket and a re-connect opens a new one', () => {
    service.connect();
    expect(sockets.length).toBe(1);
    service.disconnect();
    expect(sockets[0].closed).toBe(true);
    service.connect();
    expect(sockets.length).toBe(2);
  });
});
