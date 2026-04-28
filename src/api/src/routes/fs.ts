// src/api/src/routes/fs.ts
//
// GET /api/fs/list?path=<abs>&showAll=0|1
//
// Lists subdirectories under `path`. Used by the library-picker UI on the
// empty-state of Maple Self Hosted to let the user navigate the mounted
// volumes and pick a folder to register.
//
// Path is jailed by MAPLE_ROOTS env (default: '/'). System directories
// (/proc /etc /usr /app …) are hidden at the filesystem root unless
// showAll=1.

import { Elysia, t } from "elysia";
import { listDir } from "../fs/browse.ts";

export const fsRoutes = new Elysia({ prefix: "/api/fs" }).get(
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
);
