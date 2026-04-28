// src/api/src/fs/browse.ts
//
// Filesystem browse helper for the library-picker UI.
//
// Lists subdirectories under a path with a `MAPLE_ROOTS` jail (default '/')
// and a system-directory denylist that hides /proc, /etc, /usr, /app, ... at
// the filesystem root unless `showAll` is true.

import { readdir, realpath, stat } from "node:fs/promises";
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

  let rawEntries: { name: string }[];
  try {
    rawEntries = await readdir(real, { withFileTypes: false }).then(
      (names) => names.map((n) => ({ name: n })),
    );
  } catch (err) {
    return { ok: false, error: `Cannot list "${real}": ${err instanceof Error ? err.message : String(err)}` };
  }

  const atRoot = real === "/";

  // Pre-filter by name (hidden files, system dirs at root) before the
  // per-entry async work so we skip obviously unwanted entries cheaply.
  const candidates = rawEntries
    .filter((e) => !e.name.startsWith("."))
    .filter((e) => showAll || !atRoot || !SYSTEM_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: DirEntry[] = [];
  for (const e of candidates) {
    const childCandidate = real === "/" ? "/" + e.name : `${real}/${e.name}`;

    // Issue 1 fix: re-resolve the child's realpath and re-check the jail to
    // prevent symlink-swap attacks between parent readdir and child access.
    let childReal: string;
    try {
      childReal = await realpath(childCandidate);
    } catch {
      // Broken symlink or permission denied — drop entry entirely.
      continue;
    }
    if (!roots.some((r) => isUnderRoot(childReal, r))) {
      // Child escaped the jail (e.g. symlink pointing outside MAPLE_ROOTS).
      // Drop the entry — including its path would leak information.
      continue;
    }

    // Issue 2 fix: use stat() (follows symlinks) to confirm the target is
    // actually a directory. Symlinks to files are silently dropped.
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(childReal);
    } catch {
      // Permission denied or race — drop entry.
      continue;
    }
    if (!st.isDirectory()) continue;

    // Compute hasChildren using the jail-verified, realpath-resolved path.
    let hasChildren = false;
    try {
      const sub = await readdir(childReal, { withFileTypes: true });
      hasChildren = sub.some(
        (s) => !s.name.startsWith(".") && (s.isDirectory() || s.isSymbolicLink()),
      );
    } catch {
      // Permission denied / unreadable — show but mark childless.
      hasChildren = false;
    }

    out.push({ name: e.name, path: childReal, hasChildren });
  }

  // Issue 3 fix: return realpath form consistently for DirListing.path,
  // DirListing.parent, and entries[].path so the picker UI never sees a
  // path-style flip (e.g. /var vs /private/var on macOS) mid-navigation.
  const isRoot = real === "/";
  return {
    ok: true,
    data: {
      path: real,
      parent: isRoot ? null : path.dirname(real),
      entries: out,
    },
  };
}
