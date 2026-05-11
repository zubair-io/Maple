// src/api/src/routes/fs.ts
//
// GET /api/fs/list?path=<abs>&showAll=0|1
//   Lists subdirectories under `path` (no files). Used by the library-picker
//   empty-state to let the user pick a folder to register.
//
// GET /api/fs/dir?path=<abs>
//   Lists subdirectories AND image files at a single directory level. Used
//   by the "browse by walking the filesystem" tree-view. Does NOT recurse.
//   Filters images to extensions the thumb endpoint can render — RAWs plus
//   common bitmap formats (jpg/jpeg/png/webp/gif/tif/tiff/heic/heif/avif),
//   case-insensitive. Hides dotfiles/dotdirs (including `.maple/`).
//
// GET /api/fs/raw?path=<abs>
//   Streams the raw file bytes (Content-Type: application/octet-stream) for
//   the editor to pipe into the WASM decode + develop pipeline. Same RAW
//   extension allowlist as `/api/fs/dir` and `/api/fs/thumb`.
//
// All endpoints share the same MAPLE_ROOTS jail and system-directory
// denylist enforced in `../fs/browse.ts`.

import { Elysia, t } from "elysia";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { listDir, listDirContents, browseRoots, isUnderRoot, RAW_EXTENSIONS } from "../fs/browse.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("fs/dir");

export const fsRoutes = new Elysia({ prefix: "/api/fs" })
  .get(
    "/list",
    async ({ query, set }) => {
      const reqPath = query.path;
      const showAll = query.showAll === "1" || query.showAll === "true";

      const res = await listDir(reqPath, showAll);
      if (!res.ok) {
        set.status = 400;
        return { error: res.error };
      }
      return res.data!;
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
        showAll: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/dir",
    async ({ query, set }) => {
      try {
        const res = await listDirContents(query.path);
        if (!res.ok) {
          // 400 covers both "outside MAPLE_ROOTS" and "cannot access" — the
          // listDirContents error message distinguishes them.
          set.status = 400;
          return { error: res.error };
        }
        return res.data!;
      } catch (err) {
        // Defensive: if anything inside listDirContents throws (e.g. a
        // permission edge case on a child entry that escapes the inner
        // try/catch), surface as JSON 500 so the SPA can render a banner
        // instead of getting an opaque error page.
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ path: query.path, err: msg }, "unhandled error");
        set.status = 500;
        return { error: msg };
      }
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
      }),
    },
  )
  .get(
    "/raw",
    async ({ query, set }) => {
      const reqPath = query.path;
      if (!path.isAbsolute(reqPath)) {
        set.status = 400;
        return { error: "path must be absolute" };
      }
      let real: string;
      try {
        real = await realpath(reqPath);
      } catch (err) {
        set.status = 404;
        return {
          error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const roots = await browseRoots();
      if (!roots.some((r) => isUnderRoot(real, r))) {
        set.status = 403;
        return { error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(", ")}]` };
      }
      const dot = real.lastIndexOf(".");
      const ext = dot >= 0 ? real.slice(dot + 1).toLowerCase() : "";
      if (!RAW_EXTENSIONS.has(ext)) {
        set.status = 415;
        return { error: `Unsupported file extension: "${ext}"` };
      }
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(real);
      } catch (err) {
        set.status = 404;
        return {
          error: `Cannot stat "${real}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!st.isFile()) {
        set.status = 400;
        return { error: `"${real}" is not a regular file` };
      }
      // Stream the bytes. Web ReadableStream is built from the Node stream
      // so we don't have to slurp 100MP RAWs (~200MB) into memory.
      const nodeStream = createReadStream(real);
      // Cast through `unknown` because @types/node's `node:stream/web`
      // ReadableStream and the DOM ReadableStream lib types don't share a
      // structural overlap (different `getReader` overload signatures), but
      // they're the same runtime type — bun:Response accepts either.
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(st.size),
          "Cache-Control": "private, max-age=86400",
          ETag: `"${Math.floor(st.mtimeMs)}-${st.size}"`,
        },
      });
    },
    {
      query: t.Object({
        path: t.String({ minLength: 1 }),
      }),
    },
  );
