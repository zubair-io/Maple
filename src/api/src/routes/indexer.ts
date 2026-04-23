/**
 * Indexer progress route.
 *
 * GET /api/indexer/progress — Server-Sent Events stream of task progress.
 * GET /api/indexer/stats    — current queue statistics (JSON).
 */

import { Elysia } from "elysia";
import { progressBus, queueStats, type ProgressEvent } from "../indexer/queue.ts";

export const indexerRoutes = new Elysia({ prefix: "/api/indexer" })
  // Queue stats (JSON)
  .get("/stats", () => queueStats())

  // SSE stream for indexer progress
  .get("/progress", ({ set }) => {
    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";
    set.headers["X-Accel-Buffering"] = "no"; // disable nginx buffering

    // Return a ReadableStream that emits SSE events.
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(ev: ProgressEvent): void {
          const data = JSON.stringify(ev);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }

        // Send an initial "connected" event.
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ connected: true })}\n\n`)
        );

        progressBus.on("progress", sendEvent);

        // Clean up when the client disconnects.
        // (ReadableStream cancel is called by Elysia/Bun when the request ends.)
        return () => {
          progressBus.off("progress", sendEvent);
        };
      },
      cancel() {
        // Listener cleanup happens in start() return function.
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });
