// src/api/src/fs/browse.ts
//
// Filesystem browse helper for the library-picker UI.
//
// Lists subdirectories under a path with a `MAPLE_ROOTS` jail (default '/')
// and a system-directory denylist that hides /proc, /etc, /usr, /app, ... at
// the filesystem root unless `showAll` is true.

import { readdir, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { OpResult } from "./root.ts";

export interface DirEntry {
  name: string;
  path: string;       // absolute, symlink-resolved
  hasChildren: boolean;
}

export interface DirListing {
  path: string;       // absolute, symlink-resolved
  parent: string | null;
  entries: DirEntry[];
}

/** Linux/macOS directory names hidden at the filesystem root unless showAll=1. */
const SYSTEM_DIRS = new Set<string>([
  "proc", "sys", "dev", "run", "boot",
  "bin", "sbin", "lib", "lib32", "lib64",
  "usr", "etc", "var", "tmp",
  "root", "opt", "srv",
  "private",  // macOS
  "app",      // container working dir
  "node_modules",
]);

async function browseRoots(): Promise<string[]> {
  const env = process.env.MAPLE_ROOTS;
  if (!env || env.trim() === "") return ["/"];
  const raw = env.split(":").map((p) => p.replace(/\/$/, "")).filter(Boolean);
  // Resolve symlinks in each root so the jail check works on macOS where
  // /var → /private/var (and the realpath of reqPath will be /private/var/…).
  const resolved = await Promise.all(
    raw.map(async (r) => {
      try {
        return await realpath(r);
      } catch {
        return r;
      }
    }),
  );
  return resolved;
}

function isUnderRoot(absPath: string, root: string): boolean {
  const r = root.replace(/\/$/, "") || "/";
  if (r === "/") return true;
  return absPath === r || absPath.startsWith(r + "/");
}

export async function listDir(
  reqPath: string,
  showAll: boolean,
): Promise<OpResult<DirListing>> {
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, error: "Path must be absolute." };
  }

  let real: string;
  try {
    real = await realpath(reqPath);
  } catch (err) {
    return { ok: false, error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const roots = await browseRoots();
  if (!roots.some((r) => isUnderRoot(real, r))) {
    return {
      ok: false,
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(", ")}]`,
    };
  }

  let raw: { name: string; isDir: boolean }[];
  try {
    const entries = await readdir(real, { withFileTypes: true });
    raw = entries.map((e) => ({
      name: e.name,
      isDir: e.isDirectory() || e.isSymbolicLink(),
    }));
  } catch (err) {
    return { ok: false, error: `Cannot list "${real}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const atRoot = real === "/";
  const visible = raw
    .filter((e) => e.isDir)
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => showAll || !atRoot || !SYSTEM_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: DirEntry[] = [];
  for (const e of visible) {
    const full = real === "/" ? "/" + e.name : `${real}/${e.name}`;
    let hasChildren = false;
    try {
      const sub = await readdir(full, { withFileTypes: true });
      hasChildren = sub.some(
        (s) => (s.isDirectory() || s.isSymbolicLink()) && !s.name.startsWith("."),
      );
    } catch {
      // Permission denied / unreadable — show but mark childless.
      hasChildren = false;
    }
    out.push({ name: e.name, path: full, hasChildren });
  }

  // Use path.resolve (normalise without following symlinks) for the returned
  // `path` and `parent` so that callers on macOS (where /var → /private/var)
  // get values consistent with the path they supplied.  The symlink-resolved
  // `real` is used only for internal jail-checking and readdir I/O.
  const normalReq = path.resolve(reqPath);
  const isRoot = real === "/";
  return {
    ok: true,
    data: {
      path: normalReq,
      parent: isRoot ? null : path.dirname(normalReq),
      entries: out,
    },
  };
}
