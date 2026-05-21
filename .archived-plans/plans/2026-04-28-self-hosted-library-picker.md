# Self-Hosted Library Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app folder picker to Maple Self Hosted so a user with a fresh install — or someone who has mounted multiple Docker volumes — can browse the server's filesystem from `/`, pick one or more directories, and register them as photo libraries without `curl` or container restarts.

**Architecture:** A new server-side endpoint `GET /api/fs/list` walks any directory the Bun process can read, gated by an optional `MAPLE_ROOTS` env jail (default: `/`). Common Linux system directories are hidden unless the caller passes `?showAll=1`. A new Angular `LibraryPickerComponent` (in `maple-common`) consumes the endpoint and calls the existing `BunApiBackendService.registerFolder()`. The empty-state branch of `browse-shell.component.html` swaps from a dead-end "Configure folders in admin…" banner to mounting the picker.

**Tech Stack:** Bun + Elysia + TypeScript (server), Angular 21 standalone + signals + RxJS (UI), `bun:test` for server tests, Karma/Jasmine `.spec.ts` for Angular unit tests.

---

## File Structure

**Server (Bun + Elysia):**
- Create: `src/api/src/fs/browse.ts` — pure helper that lists a directory with system-dir filtering and `MAPLE_ROOTS` jail check
- Create: `src/api/src/routes/fs.ts` — Elysia plugin exposing `GET /api/fs/list`
- Modify: `src/api/src/index.ts` — register the new plugin
- Create: `src/api/tests/browse.test.ts` — unit tests for `browse.ts`
- Create: `src/api/tests/fs-route.test.ts` — integration tests via Elysia `.handle()`
- Modify: `src/api/README.md` — document the new endpoint and `MAPLE_ROOTS` default

**UI (Angular `maple-common`):**
- Modify: `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts` — add `listDir()` + `ListDirResponse` interface
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.ts`
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.html`
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.scss`
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.spec.ts`
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.ts` — add `addLibraryFolder(path: string)` that POSTs and refreshes the tree
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts` — cover the add flow
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.html` — replace empty-state banner with `<app-library-picker>`
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.ts` — import the new component

**Public API export:**
- Modify: `src/web/projects/maple-common/src/public-api.ts` — re-export `LibraryPickerComponent`

---

## Task 1: Server — `browse.ts` helper with `MAPLE_ROOTS` default to `/`

**Files:**
- Create: `src/api/src/fs/browse.ts`
- Test: `src/api/tests/browse.test.ts`

The helper resolves a path under `MAPLE_ROOTS` (default `/` when unset), reads its directory entries, drops symlink-resolved paths that escape the jail, and applies a system-directory denylist unless `showAll` is set. Lives in `fs/` next to the existing `root.ts` so the path-safety code stays co-located.

- [ ] **Step 1.1: Write the failing tests**

```typescript
// src/api/tests/browse.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

describe("listDir", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-browse-"));
    await fs.mkdir(path.join(tmpRoot, "photos"));
    await fs.mkdir(path.join(tmpRoot, "docs"));
    await fs.writeFile(path.join(tmpRoot, "readme.txt"), "x");
    await fs.mkdir(path.join(tmpRoot, ".hidden"));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("lists subdirectories of a real path", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    process.env.MAPLE_ROOTS = tmpRoot;
    const res = await listDir(tmpRoot, false);
    delete process.env.MAPLE_ROOTS;

    expect(res.ok).toBe(true);
    expect(res.data!.path).toBe(tmpRoot);
    const names = res.data!.entries.map((e) => e.name).sort();
    expect(names).toEqual(["docs", "photos"]); // hidden + non-dirs filtered
  });

  it("rejects a path outside MAPLE_ROOTS", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    process.env.MAPLE_ROOTS = tmpRoot;
    const res = await listDir("/etc", false);
    delete process.env.MAPLE_ROOTS;

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside.*MAPLE_ROOTS/i);
  });

  it("defaults MAPLE_ROOTS to '/' when unset", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir(tmpRoot, false);
    expect(res.ok).toBe(true);
  });

  it("filters system directories at root when showAll=false", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir("/", false);
    expect(res.ok).toBe(true);
    const names = res.data!.entries.map((e) => e.name);
    // None of the canonical system dirs should appear.
    for (const sys of ["proc", "sys", "dev", "etc", "var", "usr", "bin", "sbin"]) {
      expect(names).not.toContain(sys);
    }
  });

  it("returns system directories when showAll=true and they exist", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir("/", true);
    expect(res.ok).toBe(true);
    // On any Unix, /etc exists. On macOS /etc is a symlink → still listed.
    const names = res.data!.entries.map((e) => e.name);
    expect(names).toContain("etc");
  });

  it("returns parent path for non-root directories", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir(tmpRoot, false);
    expect(res.ok).toBe(true);
    expect(res.data!.parent).toBe(path.dirname(tmpRoot));
  });

  it("returns null parent for filesystem root", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir("/", false);
    expect(res.ok).toBe(true);
    expect(res.data!.parent).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run the tests and confirm they fail**

Run: `cd src/api && bun test tests/browse.test.ts`
Expected: all tests fail with `Cannot find module '../src/fs/browse.ts'`

- [ ] **Step 1.3: Implement `listDir`**

```typescript
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

function browseRoots(): string[] {
  const env = process.env.MAPLE_ROOTS;
  if (!env || env.trim() === "") return ["/"];
  return env.split(":").map((p) => p.replace(/\/$/, "")).filter(Boolean);
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

  const roots = browseRoots();
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

  return {
    ok: true,
    data: {
      path: real,
      parent: real === "/" ? null : path.dirname(real),
      entries: out,
    },
  };
}
```

- [ ] **Step 1.4: Run the tests and confirm they pass**

Run: `cd src/api && bun test tests/browse.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/api/src/fs/browse.ts src/api/tests/browse.test.ts
git commit -m "feat(api): add fs browse helper for library picker

MAPLE_ROOTS defaults to '/' when unset (Docker mount is the jail).
System dirs (/proc /etc /usr /app etc.) hidden at root unless showAll=1."
```

---

## Task 2: Server — `GET /api/fs/list` route

**Files:**
- Create: `src/api/src/routes/fs.ts`
- Test: `src/api/tests/fs-route.test.ts`

Thin Elysia plugin that wraps `listDir`. Validates query params, maps `OpResult` errors to 400, returns `DirListing` JSON on success.

- [ ] **Step 2.1: Write the failing tests**

```typescript
// src/api/tests/fs-route.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

describe("GET /api/fs/list", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fsroute-"));
    await fs.mkdir(path.join(tmpRoot, "photos"));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns a JSON listing for a valid path", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const app = fsRoutes;
    const res = await app.handle(
      new Request(`http://x/api/fs/list?path=${encodeURIComponent(tmpRoot)}`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.path).toBe(tmpRoot);
    expect(Array.isArray(json.entries)).toBe(true);
    expect(json.entries.find((e: any) => e.name === "photos")).toBeDefined();
  });

  it("400s on a missing path query param", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(new Request("http://x/api/fs/list"));
    expect(res.status).toBe(400);
  });

  it("400s on a relative path", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://x/api/fs/list?path=relative/path"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/absolute/i);
  });

  it("respects showAll=1", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://x/api/fs/list?path=/&showAll=1"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // /etc exists on macOS and Linux; with showAll=1 it's included.
    expect(json.entries.some((e: any) => e.name === "etc")).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run the tests and confirm they fail**

Run: `cd src/api && bun test tests/fs-route.test.ts`
Expected: fails with `Cannot find module '../src/routes/fs.ts'`.

- [ ] **Step 2.3: Implement the route**

```typescript
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
```

- [ ] **Step 2.4: Run the tests and confirm they pass**

Run: `cd src/api && bun test tests/fs-route.test.ts`
Expected: 4 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/api/src/routes/fs.ts src/api/tests/fs-route.test.ts
git commit -m "feat(api): add GET /api/fs/list for library picker"
```

---

## Task 3: Server — Wire route into the main app

**Files:**
- Modify: `src/api/src/index.ts:17-24` (imports), `:82-91` (`.use()` chain), `:7-15` (env-var docs)
- Modify: `src/api/README.md` (API reference + env-var table)

- [ ] **Step 3.1: Add the import and register the plugin in `index.ts`**

In `src/api/src/index.ts`, add this import next to the other route imports:

```typescript
import { fsRoutes } from "./routes/fs.ts";
```

Then in the `.use(...)` chain on `app`, add `.use(fsRoutes)` immediately after `.use(authRoutes)`:

```typescript
  .use(healthRoutes)
  .use(foldersRoutes)
  .use(assetsRoutes)
  .use(indexerRoutes)
  .use(eventsRoutes)
  .use(authRoutes)
  .use(fsRoutes)

  // Static UI (catch-all — must be last)
  .use(staticUiPlugin);
```

Update the env-var docstring at the top of `index.ts` to reflect the new default for `MAPLE_ROOTS`:

```typescript
 *   MAPLE_ROOTS        — colon-separated allowed FS roots for browsing &
 *                        registered-folder access. Defaults to '/' (Docker
 *                        mount is the jail). Set explicitly when running
 *                        natively to limit reach.
```

- [ ] **Step 3.2: Update `README.md` env-var table and API reference**

In `src/api/README.md`, change the `MAPLE_ROOTS` row in the env-var table to:

```
| `MAPLE_ROOTS` | `/` | Colon-separated FS roots the server may browse and read. Defaults to `/` (Docker mount is the jail). |
```

Add to the API reference section, after the `/api/auth/*` lines and before the SPA catch-all:

```
GET  /api/fs/list?path=<abs>&showAll=0|1   — list subdirectories under <abs> (library picker)
```

- [ ] **Step 3.3: Smoke test the route end-to-end**

Run: `cd src/api && bun src/index.ts &` (background)
Then: `curl -s "http://localhost:3000/api/fs/list?path=/" | head -c 400`
Expected: JSON response with `"path":"/"`, `"parent":null`, and an `entries` array that does NOT include `etc`/`usr`/`var`.

Then: `curl -s "http://localhost:3000/api/fs/list?path=/&showAll=1" | head -c 400`
Expected: JSON response that DOES include `etc`/`usr`/`var`.

Stop the server: `kill %1`.

- [ ] **Step 3.4: Commit**

```bash
git add src/api/src/index.ts src/api/README.md
git commit -m "feat(api): mount /api/fs/list and document MAPLE_ROOTS default"
```

---

## Task 4: UI — Extend `BunApiBackendService` with `listDir`

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts`

- [ ] **Step 4.1: Add the response interface and method**

Add this interface near the existing `ApiFolder`/`ApiAsset` definitions (after `ApiAssetPage`):

```typescript
export interface ApiDirEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

export interface ApiDirListing {
  path: string;
  parent: string | null;
  entries: ApiDirEntry[];
}
```

Inside the `BunApiBackendService` class, add this method after `registerFolder`:

```typescript
  listDir(absPath: string, showAll = false): Observable<ApiDirListing> {
    const params = new URLSearchParams({ path: absPath });
    if (showAll) params.set('showAll', '1');
    return this.http.get<ApiDirListing>(`${this.base}/fs/list?${params.toString()}`);
  }
```

- [ ] **Step 4.2: Verify TypeScript compiles**

Run: `cd src/web && bun x ng build maple-common --configuration=development 2>&1 | tail -20`
Expected: build succeeds with no `TS2304` / `TS2322` errors.

- [ ] **Step 4.3: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts
git commit -m "feat(maple-common): add BunApiBackendService.listDir() for picker"
```

---

## Task 5: UI — `LibraryPickerComponent`

**Files:**
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.ts`
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.html`
- Create: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.scss`
- Test: `src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.spec.ts`

Standalone component, signals-based, OnPush. Holds a `current` signal for the path being shown, `entries` signal for its children, `loading` signal. A `back` button navigates to `current.parent`; clicking an entry calls `listDir(entry.path)`. A "Use this folder" button emits `pick` output with the `current` path.

- [ ] **Step 5.1: Write the failing component spec**

```typescript
// src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.spec.ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { LibraryPickerComponent } from './library-picker.component';
import { API_BASE_URL } from '../../api/api-base-url.token';

describe('LibraryPickerComponent', () => {
  let fixture: ComponentFixture<LibraryPickerComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LibraryPickerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    fixture = TestBed.createComponent(LibraryPickerComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it("loads '/' on init and shows entries", () => {
    const req = http.expectOne((r) => r.url === '/api/fs/list' && r.params.get('path') === '/');
    req.flush({
      path: '/',
      parent: null,
      entries: [
        { name: 'photos', path: '/photos', hasChildren: true },
        { name: 'external', path: '/external', hasChildren: false },
      ],
    });
    fixture.detectChanges();

    const labels = (fixture.nativeElement as HTMLElement).querySelectorAll('.entry .name');
    expect(labels.length).toBe(2);
    expect(labels[0].textContent).toContain('photos');
  });

  it('navigates into a clicked entry', () => {
    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [{ name: 'photos', path: '/photos', hasChildren: true }],
    });
    fixture.detectChanges();

    const entry = fixture.nativeElement.querySelector('.entry') as HTMLElement;
    entry.click();
    fixture.detectChanges();

    const req = http.expectOne((r) => r.params.get('path') === '/photos');
    req.flush({
      path: '/photos',
      parent: '/',
      entries: [{ name: '2024', path: '/photos/2024', hasChildren: false }],
    });
    fixture.detectChanges();

    const heading = fixture.nativeElement.querySelector('.path') as HTMLElement;
    expect(heading.textContent).toContain('/photos');
  });

  it('emits pick(path) when "Use this folder" is clicked', () => {
    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [],
    });
    fixture.detectChanges();

    let picked: string | null = null;
    fixture.componentInstance.pick.subscribe((p) => (picked = p));

    const useBtn = fixture.nativeElement.querySelector('button.use') as HTMLButtonElement;
    useBtn.click();

    expect(picked).toBe('/');
  });

  it('Up button navigates to parent', () => {
    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [{ name: 'photos', path: '/photos', hasChildren: true }],
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.entry') as HTMLElement).click();
    fixture.detectChanges();

    http.expectOne((r) => r.params.get('path') === '/photos').flush({
      path: '/photos',
      parent: '/',
      entries: [],
    });
    fixture.detectChanges();

    const upBtn = fixture.nativeElement.querySelector('button.up') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(false);
    upBtn.click();
    fixture.detectChanges();

    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [],
    });
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector('.path') as HTMLElement;
    expect(heading.textContent).toContain('/');
  });

  it('toggles showAll and refetches', () => {
    http.expectOne((r) => r.params.get('path') === '/' && !r.params.get('showAll')).flush({
      path: '/',
      parent: null,
      entries: [],
    });
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('input.show-all') as HTMLInputElement;
    toggle.click();
    fixture.detectChanges();

    http.expectOne((r) => r.params.get('path') === '/' && r.params.get('showAll') === '1').flush({
      path: '/',
      parent: null,
      entries: [{ name: 'etc', path: '/etc', hasChildren: true }],
    });
    fixture.detectChanges();

    const labels = fixture.nativeElement.querySelectorAll('.entry .name');
    expect(labels[0].textContent).toContain('etc');
  });
});
```

- [ ] **Step 5.2: Run the spec and confirm it fails**

Run: `cd src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless --include='**/library-picker.component.spec.ts'`
Expected: fails with `Cannot find module './library-picker.component'`.

- [ ] **Step 5.3: Create the component class**

```typescript
// src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.ts
//
// First-run library picker for Maple Self Hosted.
// Walks the server filesystem via /api/fs/list starting at '/', lets the
// user navigate into mounted volumes, and emits the chosen absolute path.

import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { BunApiBackendService, type ApiDirListing } from '../../api/bun-api-backend.service';

@Component({
  selector: 'app-library-picker',
  standalone: true,
  templateUrl: './library-picker.component.html',
  styleUrl: './library-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPickerComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);

  readonly listing = signal<ApiDirListing | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly showAll = signal(false);

  readonly pick = output<string>();
  readonly cancel = output<void>();

  ngOnInit(): void {
    this.navigate('/');
  }

  navigate(absPath: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.listDir(absPath, this.showAll()).subscribe({
      next: (data) => {
        this.listing.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to list directory.');
      },
    });
  }

  onUp(): void {
    const parent = this.listing()?.parent;
    if (parent) this.navigate(parent);
  }

  onUseHere(): void {
    const p = this.listing()?.path;
    if (p) this.pick.emit(p);
  }

  onToggleShowAll(): void {
    this.showAll.update((v) => !v);
    const cur = this.listing()?.path ?? '/';
    this.navigate(cur);
  }
}
```

- [ ] **Step 5.4: Create the template**

```html
<!-- src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.html -->
<div class="picker">
  <header>
    <h2>Pick a library folder</h2>
    <p class="hint">
      Browse the server filesystem and pick a folder to index. You can register
      additional folders later from the sidebar.
    </p>
  </header>

  <div class="toolbar">
    <button class="up" (click)="onUp()" [disabled]="!listing()?.parent">↑ Up</button>
    <code class="path">{{ listing()?.path ?? 'Loading…' }}</code>
    <label class="show-all-label">
      <input type="checkbox" class="show-all" [checked]="showAll()" (change)="onToggleShowAll()" />
      Show system folders
    </label>
  </div>

  @if (loading()) {
    <div class="status">Loading…</div>
  } @else if (error(); as e) {
    <div class="status error">{{ e }}</div>
  } @else if ((listing()?.entries?.length ?? 0) === 0) {
    <div class="status empty">(no subfolders here)</div>
  } @else {
    <ul class="entries">
      @for (e of listing()!.entries; track e.path) {
        <li class="entry" (click)="navigate(e.path)">
          <span class="name">{{ e.name }}</span>
          @if (e.hasChildren) {
            <span class="chev">›</span>
          }
        </li>
      }
    </ul>
  }

  <footer>
    <button class="cancel" type="button" (click)="cancel.emit()">Cancel</button>
    <button class="use" type="button" (click)="onUseHere()" [disabled]="!listing()">
      Use this folder
    </button>
  </footer>
</div>
```

- [ ] **Step 5.5: Create minimal styles**

```scss
// src/web/projects/maple-common/src/lib/components/library-picker/library-picker.component.scss
:host {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 32px;
  box-sizing: border-box;
  background: var(--maple-bg, #1c1c1e);
  color: var(--maple-text-main, #f2f2f7);
}

.picker {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--maple-bg-elev, #2c2c2e);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

header h2 { margin: 0 0 4px 0; font-size: 16px; font-weight: 600; }
header .hint { margin: 0; font-size: 12px; color: var(--maple-text-muted, #999); }

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.toolbar .path {
  flex: 1;
  font-family: ui-monospace, monospace;
  background: rgba(0, 0, 0, 0.3);
  padding: 4px 8px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toolbar button { padding: 4px 10px; font-size: 12px; }
.show-all-label { display: flex; gap: 6px; align-items: center; user-select: none; }

.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}
.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.entry:last-child { border-bottom: none; }
.entry:hover { background: rgba(255, 255, 255, 0.06); }
.entry .name { font-size: 13px; }
.entry .chev { color: var(--maple-text-muted, #999); }

.status { padding: 24px; text-align: center; color: var(--maple-text-muted, #999); font-size: 12px; }
.status.error { color: var(--maple-text-err, #ff6b6b); }

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
footer button { padding: 6px 14px; font-size: 13px; }
footer .use { background: var(--maple-accent, #4a8fea); color: white; }
footer .use:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 5.6: Run the spec and confirm it passes**

Run: `cd src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless --include='**/library-picker.component.spec.ts'`
Expected: 5 tests pass.

- [ ] **Step 5.7: Export from public-api**

In `src/web/projects/maple-common/src/public-api.ts`, add:

```typescript
export * from './lib/components/library-picker/library-picker.component';
```

- [ ] **Step 5.8: Commit**

```bash
git add src/web/projects/maple-common/src/lib/components/library-picker \
        src/web/projects/maple-common/src/public-api.ts
git commit -m "feat(maple-common): add LibraryPickerComponent for self-hosted onboarding"
```

---

## Task 6: UI — `LibraryStateService.addLibraryFolder()`

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.ts`
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts`

Add a method that POSTs the picked path, on success refreshes the folder tree, on failure surfaces a toast/error via the existing `backendError` signal.

- [ ] **Step 6.1: Write the failing spec**

In `library-state.service.spec.ts`, add this `describe` block at the bottom (inside the existing top-level `describe`, mirror the existing TestBed setup pattern). Read the file first to find the existing harness — reuse its `httpTesting` controller and `service` reference:

```typescript
  describe('addLibraryFolder (self-hosted)', () => {
    it('POSTs the path and refreshes the tree on success', () => {
      service.addLibraryFolder('/photos');

      const post = httpTesting.expectOne((r) => r.method === 'POST' && r.url.endsWith('/folders'));
      expect(post.request.body).toEqual({ path: '/photos' });
      post.flush({ id: 'f1', path: '/photos', name: 'photos', assetCount: 0 });

      // After success, listFolders is called to refresh.
      const list = httpTesting.expectOne((r) => r.method === 'GET' && r.url.endsWith('/folders'));
      list.flush([{ id: 'f1', path: '/photos', name: 'photos', assetCount: 0 }]);

      expect(service.backendEmpty()).toBe(false);
    });

    it('sets backendError on failure', () => {
      service.addLibraryFolder('/bad');

      const post = httpTesting.expectOne((r) => r.method === 'POST' && r.url.endsWith('/folders'));
      post.flush({ error: 'nope' }, { status: 400, statusText: 'Bad Request' });

      expect(service.backendError()).toContain('nope');
    });
  });
```

- [ ] **Step 6.2: Run the spec and confirm it fails**

Run: `cd src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless --include='**/library-state.service.spec.ts'`
Expected: fails — `service.addLibraryFolder is not a function`.

- [ ] **Step 6.3: Implement `addLibraryFolder`**

In `library-state.service.ts`, add this method immediately after `loadFolderTree`:

```typescript
  /**
   * Self-Hosted: register a new library folder, then refresh the tree.
   * Called by LibraryPickerComponent on the empty-state of BrowseShell.
   */
  addLibraryFolder(absPath: string): void {
    if (this.backend !== 'self-hosted') return;

    this.backendLoading.set(true);
    this.backendError.set(null);

    this.api.registerFolder(absPath).subscribe({
      next: () => {
        this.loadFolderTree();
      },
      error: (err: HttpErrorResponse) => {
        this.backendLoading.set(false);
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.backendError.set(`Failed to register folder: ${detail}`);
      },
    });
  }
```

- [ ] **Step 6.4: Run the spec and confirm it passes**

Run: `cd src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless --include='**/library-state.service.spec.ts'`
Expected: existing tests + 2 new ones pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/state/library-state.service.ts \
        src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts
git commit -m "feat(maple-common): LibraryStateService.addLibraryFolder()"
```

---

## Task 7: UI — Mount the picker in BrowseShell empty state

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.html`
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.ts`

Replace the current "Configure folders in admin…" `<app-error-banner>` block with `<app-library-picker (pick)="state.addLibraryFolder($event)">`.

- [ ] **Step 7.1: Update the template**

In `browse-shell.component.html`, replace lines 66-73 (the `@if (state.backendEmpty() …)` block) with:

```html
        @if (state.backendEmpty() && !state.backendLoading() && !state.backendError()) {
          <app-library-picker (pick)="state.addLibraryFolder($event)" />
        }
```

- [ ] **Step 7.2: Import the component in the shell**

In `browse-shell.component.ts`, add to the existing `imports: [...]` array on the `@Component` decorator: `LibraryPickerComponent`. Add the matching import at the top of the file:

```typescript
import { LibraryPickerComponent } from '../../components/library-picker/library-picker.component';
```

- [ ] **Step 7.3: Build the workspace to confirm wiring compiles**

Run: `cd src/web && bun x ng build maple-common --configuration=development 2>&1 | tail -10`
Expected: build succeeds with no errors. Then build the consuming app:

Run: `cd src/web && bun x ng build maple-self-hosted --configuration=development 2>&1 | tail -10`
Expected: build succeeds.

- [ ] **Step 7.4: Commit**

```bash
git add src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.html \
        src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.ts
git commit -m "feat(maple-common): mount LibraryPicker on browse-shell empty state"
```

---

## Task 8: End-to-end smoke test

**Files:** none (manual verification)

Verify the full flow works against a real Bun server + Mongo + browser. This is the only step that proves the feature works as intended.

- [ ] **Step 8.1: Start MongoDB and the API in dev mode**

Run in one terminal:
```bash
cd src/api && docker compose up -d mongo
bun src/index.ts
```
Expected output includes `Listening on http://localhost:3000`, `[server] DB ready`, `[server] Indexer started`.

- [ ] **Step 8.2: Wipe registered folders so the empty-state triggers**

Run in a second terminal:
```bash
docker compose -f src/api/docker-compose.yml exec mongo \
  mongosh maple_self_hosted --eval 'db.folders.deleteMany({})'
```
Expected: `{ acknowledged: true, deletedCount: <n> }` — `n` may be 0 if the DB was already empty.

- [ ] **Step 8.3: Build and serve the Self-Hosted UI bundle**

Run in a third terminal:
```bash
cd src/web && bun x ng build maple-self-hosted --configuration=production
```
Expected: build artifacts at `src/web/dist/maple-self-hosted/browser/`.

- [ ] **Step 8.4: Open the app in a browser and verify the picker**

Open `http://localhost:3000` in a browser. Expected:
1. The browse shell renders with an empty center column.
2. The library picker appears (heading "Pick a library folder", path `/`, list of subdirs WITHOUT `/proc /etc /var /usr`).
3. Click "Show system folders" — `/etc` etc. now appear.
4. Navigate into a real directory (e.g. `/Users` on the host if it's mounted, or `/tmp`). Path heading updates.
5. Click "Use this folder". The picker disappears, the folder shows up in the left sidebar tree, and the indexer starts scanning (watch the server logs for `[indexer] discover`).

- [ ] **Step 8.5: Stop the server and Mongo container**

```bash
# In the API terminal: Ctrl+C
cd src/api && docker compose down
```

- [ ] **Step 8.6: Update README quickstart to mention the picker**

In `src/api/README.md`, replace the Step-4 `curl` block (lines 46-50) with:

```markdown
### 4. Pick a library folder in the UI

Open `http://localhost:3000`. On first run, the empty browse shell shows a
**library picker** — navigate to your photos folder (or any subdirectory of
your Docker mount) and click "Use this folder". The Indexer starts scanning
in the background.

(For scripted setup you can still POST to `/api/folders` directly:
`curl -X POST http://localhost:3000/api/folders -H 'Content-Type: application/json' -d '{"path":"/photos"}'`.)
```

- [ ] **Step 8.7: Final commit**

```bash
git add src/api/README.md
git commit -m "docs(api): document library-picker first-run flow"
```

---

## Self-Review Notes

**Spec coverage:**
- ✅ "On first run, ask user what folder" — Task 7 mounts picker on empty state
- ✅ "Start at `/`, multi-volume support" — Task 1 `listDir('/')` works for any mount
- ✅ "`MAPLE_ROOTS` not redundant in Docker" — Task 1 defaults to `/` when unset
- ✅ "Filter known system paths" — Task 1 SYSTEM_DIRS denylist + showAll override

**Type consistency:** `ApiDirListing`/`ApiDirEntry` defined in Task 4 are consumed by Task 5; `addLibraryFolder` in Task 6 is consumed by Task 7. `listDir` (server, Task 1) and `BunApiBackendService.listDir` (UI, Task 4) share field names verbatim with the JSON wire shape.

**Out of scope (deliberate):**
- No multi-folder bulk-pick — one folder per click. Adding more is repeating the flow.
- No "Remove folder" UI — backend has no DELETE route yet, separate task.
- No Apple/Hosted variants of the picker — those use native pickers (FS Access API on web, NSOpenPanel on Apple) and are out of scope here.
