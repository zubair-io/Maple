/**
 * /api/events — WebSocket stream of indexer progress + filesystem events.
 *
 * Message shapes match the `IndexerEvent` union in indexer/service.ts:
 *   { type: "progress"; stage; queueDepth; inFlight; errors; deadLetter }
 *   { type: "fs"; event; path }
 *
 * Progress messages are throttled to once per 250 ms (one tick per stage),
 * driven by the service's internal timer. FS events are forwarded as-is.
 */

import { Elysia } from "elysia";
import { getIndexerService, type IndexerEvent } from "../indexer/service.ts";

export const eventsRoutes = new Elysia({ prefix: "/api" }).ws("/events", {
  open(ws) {
    const svc = getIndexerService();

    const handler = (ev: IndexerEvent): void => {
      // Elysia's ws.send accepts any JSON-serialisable value.
      ws.send(ev);
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
  },

  close(ws) {
    const unbind = (ws.data as Record<string, unknown>).__unbind;
    if (typeof unbind === "function") unbind();
  },
});
