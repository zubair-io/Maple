/** Temporary failure-only Linux chronology for the owned #4051 diagnostic branch. */
import { createHash } from 'node:crypto';
const key = Symbol.for('maple4051Chronology');
type Event = { sequence: number; event: string; [key: string]: unknown };
type Trace = { destination: string | null; events: Event[] };
const storage = globalThis as typeof globalThis & { [key]?: Trace };
const state = (storage[key] ??= { destination: null, events: [] });
export function startSidecarChronology(destination: string): void {
  state.destination = destination;
  state.events = [];
}
export function traceSidecar(event: string, data: Record<string, unknown>): void {
  if (state.destination === null) return;
  state.events.push({ sequence: state.events.length + 1, event, ...data });
}
export function traceSidecarBytes(event: string, xml: string | null, data = {}): void {
  if (state.destination === null) return;
  traceSidecar(event, {
    ...data,
    bytes: xml === null ? null : Buffer.byteLength(xml),
    sha256: xml === null ? null : createHash('sha256').update(xml).digest('hex'),
  });
}
export function finishSidecarChronology(): Event[] {
  const events = state.events;
  state.destination = null;
  return events;
}
