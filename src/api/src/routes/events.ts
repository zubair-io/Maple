/**
 * /api/events — WebSocket stream of indexer progress + filesystem events.
 *
 * Message shapes:
 *   { type: "status"; status: IndexerStatus; ts: number }  — full snapshot on
 *     connect and every 250 ms (emitted alongside the per-stage progress frames)
 *   { type: "progress"; stage; queueDepth; inFlight; errors; deadLetter }
 *   { type: "fs"; event; path }
 *
 * Progress messages are throttled to once per 250 ms (one tick per stage),
 * driven by the service's internal timer. FS events are forwarded as-is.
 */

import { Elysia } from "elysia";
import { getIndexerService, type IndexerEvent } from "../indexer/service.ts";
import type { PipelineStatus } from "../indexer/pipeline.ts";

/** Full status snapshot sent to WS clients for live admin panel updates. */
export interface StatusFrame {
  type: "status";
  status: PipelineStatus & { started: boolean; folders: number };
  ts: number;
}

export const eventsRoutes = new Elysia({ prefix: "/api" }).ws("/events", {
  open(ws) {
    const svc = getIndexerService();

    const handler = (ev: IndexerEvent): void => {
      // Elysia's ws.send accepts any JSON-serialisable value.
      ws.send(ev);
      // After each progress tick (one frame per stage, 6 total per 250 ms
      // cycle) also send a full status snapshot so the admin panel can update
      // without reconstructing state from per-stage deltas.
      if (ev.type === "progress") {
        const frame: StatusFrame = {
          type: "status",
          status: svc.status(),
          ts: Date.now(),
        };
        ws.send(frame);
      }
    };

    svc.events.on("event", handler);

    // Cache the unbind function on the socket so `close` can call it.
    (ws.data as Record<string, unknown>).__unbind = () => {
      svc.events.off("event", handler);
    };

    // Send a hello immediately with the current snapshot.
    const s = svc.status();
    (["discover", "hash", "exif", "thumb", "ai", "mongo"] as const).forEach((st) => {
      ws.send({
        type: "progress",
        stage: st,
        queueDepth: s.channels[st].depth,
        inFlight: s.stages[st].inFlight,
        errors: s.stages[st].errors,
        deadLetter: s.stages[st].deadLetter,
      } satisfies IndexerEvent);
    });
    // Full snapshot on connect.
    ws.send({ type: "status", status: s, ts: Date.now() } satisfies StatusFrame);
  },

  close(ws) {
    const unbind = (ws.data as Record<string, unknown>).__unbind;
    if (typeof unbind === "function") unbind();
  },
});
