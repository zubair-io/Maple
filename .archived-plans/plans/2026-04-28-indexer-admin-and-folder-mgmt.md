# Indexer Admin + Folder Management Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user (1) add more library folders from the UI after first-run, (2) watch the indexer pipeline live (per-stage worker counts, channel depths, errors, dead-letter), and (3) pause/resume the indexer.

**Architecture:** Backend gets a global pause flag — `pause()` makes every worker block before its next `channel.receive()`; `resume()` releases the gate. Two new routes wrap that. UI gains an "Add folder" button in the sidebar that opens the existing `LibraryPickerComponent` as a modal, plus an indexer-status button in the titlebar that opens an admin modal showing live counters and a pause toggle. Live updates start as a 2-second polling loop in Task 3 and get upgraded to a WebSocket subscription in Task 4.

**Tech Stack:** Bun + Elysia + TypeScript (server), Angular 21 standalone + signals + RxJS, `bun:test`, Karma/Jasmine.

**Branch:** continue on `feature/self-hosted-library-picker` (or branch from it once it merges).

---

## File Structure

**Backend (Task 1):**
- Modify: `src/api/src/indexer/pipeline.ts` — gate Promise, `pause()`/`resume()`, add `paused` to status
- Modify: `src/api/src/indexer/service.ts` — pass-through `pause()`/`resume()` on the singleton
- Modify: `src/api/src/routes/indexer.ts` — add `POST /pause` and `POST /resume`
- Create: `src/api/tests/indexer-pause.test.ts`

**UI Add-Folder Modal (Task 2):**
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.ts` — add `pickerVisible` signal + open/close methods
- Create: `src/web/projects/maple-common/src/lib/components/library-picker-modal/library-picker-modal.component.{ts,html,scss}` — overlay wrapper
- Modify: `src/web/projects/maple-common/src/lib/components/folder-tree/folder-tree.component.{ts,html,scss}` — add "+" header button
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.{ts,html}` — mount the modal at root level
- Modify: `src/web/projects/maple-common/src/public-api.ts`
- Test: `src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts` — pickerVisible toggles

**Indexer Admin Panel (Task 3):**
- Modify: `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts` — add 5 methods + types
- Create: `src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.{ts,html,scss,spec.ts}`
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.{ts,html,scss}` — add status button + mount modal
- Modify: `src/web/projects/maple-common/src/public-api.ts`

**Live WebSocket (Task 4):**
- Create: `src/web/projects/maple-common/src/lib/services/indexer-events.service.{ts,spec.ts}`
- Modify: `src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.ts` — swap polling for the WS subscription

---

## Task 1: Backend pause/resume

**Files:**
- Modify: `src/api/src/indexer/pipeline.ts`
- Modify: `src/api/src/indexer/service.ts`
- Modify: `src/api/src/routes/indexer.ts`
- Test: `src/api/tests/indexer-pause.test.ts`

**Contract:**
- `pipeline.pause()` makes every worker await a gate Promise before its next `channel.receive()`. In-flight jobs finish; nothing new is pulled.
- `pipeline.resume()` resolves the gate; workers continue.
- `status().paused: boolean` reflects state.
- `POST /api/indexer/pause` and `POST /api/indexer/resume` are idempotent (pause-when-paused = no-op).

- [ ] **Step 1.1: Write the failing test**

```typescript
// src/api/tests/indexer-pause.test.ts
import { describe, it, expect } from "bun:test";
import { Pipeline, type PipelineHandlers } from "../src/indexer/pipeline.ts";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("Pipeline pause/resume", () => {
  it("pause() stops new jobs from being pulled, resume() restarts", async () => {
    let processed = 0;
    const handlers: PipelineHandlers = {
      onDiscover: async () => {
        processed++;
        return { next: "hash" as const };
      },
    };
    const pipeline = new Pipeline(undefined, {
      discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1,
    }, handlers);
    pipeline.start();

    // Enqueue 3 discover jobs.
    for (let i = 0; i < 3; i++) {
      await pipeline.channels.discover.send({ id: String(i), absPath: `/x/${i}` });
    }
    // Let the first job process.
    await sleep(50);
    expect(processed).toBeGreaterThanOrEqual(1);

    pipeline.pause();
    expect(pipeline.status().paused).toBe(true);

    const before = processed;
    // Enqueue more — they should sit in the channel.
    for (let i = 3; i < 6; i++) {
      await pipeline.channels.discover.send({ id: String(i), absPath: `/x/${i}` });
    }
    await sleep(80);
    expect(processed).toBe(before);  // nothing new processed while paused

    pipeline.resume();
    expect(pipeline.status().paused).toBe(false);
    await sleep(80);
    expect(processed).toBeGreaterThan(before);

    await pipeline.stop();
  });

  it("pause() and resume() are idempotent", () => {
    const pipeline = new Pipeline();
    pipeline.pause();
    pipeline.pause();  // no-op
    expect(pipeline.status().paused).toBe(true);
    pipeline.resume();
    pipeline.resume();  // no-op
    expect(pipeline.status().paused).toBe(false);
  });
});

describe("POST /api/indexer/pause + /resume", () => {
  it("pauses and resumes the singleton indexer service", async () => {
    const { indexerRoutes } = await import("../src/routes/indexer.ts");

    const pauseRes = await indexerRoutes.handle(
      new Request("http://localhost/api/indexer/pause", { method: "POST" }),
    );
    expect(pauseRes.status).toBe(200);
    const pauseJson = await pauseRes.json();
    expect(pauseJson.status.paused).toBe(true);

    const resumeRes = await indexerRoutes.handle(
      new Request("http://localhost/api/indexer/resume", { method: "POST" }),
    );
    expect(resumeRes.status).toBe(200);
    const resumeJson = await resumeRes.json();
    expect(resumeJson.status.paused).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run the test and confirm it fails**

Run: `cd /Users/riabuz/Projects/_Maple/src/api && bun test tests/indexer-pause.test.ts`
Expected: tests fail because `pause`/`resume`/`paused` don't exist.

- [ ] **Step 1.3: Add gate + pause/resume to `Pipeline`**

In `src/api/src/indexer/pipeline.ts`:

(a) Add fields (next to `private running = false;`):

```typescript
  private paused = false;
  private gate: Promise<void> = Promise.resolve();
  private gateResolver: () => void = () => {};
```

(b) Add methods (next to `start()`, `stop()`, `setPool()`):

```typescript
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.gate = new Promise<void>((resolve) => {
      this.gateResolver = resolve;
    });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.gateResolver();
    this.gate = Promise.resolve();
  }
```

(c) Add `paused` to the `PipelineStatus` interface (next to `pools`):

```typescript
export interface PipelineStatus {
  channels: Record<Stage, { depth: number; capacity: number }>;
  stages: Record<Stage, StageCounters>;
  pools: Record<Stage, number>;
  paused: boolean;
}
```

(d) Update `status()` to return `paused: this.paused` in the returned object.

(e) Find the worker loop (search for the existing per-worker `while`/`for await` loop that calls `channel.receive()` — it's inside `spawnOne` or similar, around lines 268-300). Add `await this.gate;` immediately before each receive:

```typescript
    while (this.running) {
      await this.gate;
      const job = await channel.receive();
      if (job === undefined) break;  // closed
      // ... existing job-handling code ...
    }
```

(If the loop uses `for await (const job of channel)`, change it to a manual `while` loop that awaits the gate before each `receive()`.)

- [ ] **Step 1.4: Add pass-through on `IndexerService`**

In `src/api/src/indexer/service.ts`, add to the service class (next to existing `setConfig` / `status`):

```typescript
  pause(): void {
    this.pipeline.pause();
  }

  resume(): void {
    this.pipeline.resume();
  }
```

- [ ] **Step 1.5: Add the two routes**

In `src/api/src/routes/indexer.ts`, after the `.put("/config", ...)` block, add:

```typescript
  .post("/pause", () => {
    const svc = getIndexerService();
    svc.pause();
    return { ok: true, status: svc.status() };
  })

  .post("/resume", () => {
    const svc = getIndexerService();
    svc.resume();
    return { ok: true, status: svc.status() };
  })
```

Update the file's docstring to list the new routes.

- [ ] **Step 1.6: Run the tests and confirm they pass**

Run: `cd /Users/riabuz/Projects/_Maple/src/api && bun test tests/indexer-pause.test.ts`
Expected: 3/3 pass.

Then run the full suite to confirm no regressions:
```bash
cd /Users/riabuz/Projects/_Maple/src/api && bun test
```
Expected: all tests pass (was 43/43 before; should be 46/46 now).

- [ ] **Step 1.7: Commit**

```bash
git add src/api/src/indexer/pipeline.ts src/api/src/indexer/service.ts \
        src/api/src/routes/indexer.ts src/api/tests/indexer-pause.test.ts
git commit -m "feat(api): pause/resume the indexer pipeline

Adds a gate Promise that workers await before each channel.receive(),
plus pause()/resume() on Pipeline + IndexerService and POST /api/indexer/
pause and /resume routes. Idempotent. status().paused reflects state."
```

---

## Task 2: "Add folder" button + picker modal

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.{ts,spec.ts}`
- Create: `src/web/projects/maple-common/src/lib/components/library-picker-modal/library-picker-modal.component.{ts,html,scss}`
- Modify: `src/web/projects/maple-common/src/lib/components/folder-tree/folder-tree.component.{ts,html,scss}`
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.{ts,html}`
- Modify: `src/web/projects/maple-common/src/public-api.ts`

The empty-state already mounts `<app-library-picker>` directly (Task 7 of the previous plan). For "add another folder later," we need it as a dismissible overlay reachable from a button. Both surfaces can stay — the empty-state uses the inline picker, the toolbar button uses the modal wrapper.

- [ ] **Step 2.1: Add `pickerVisible` signal to state service**

In `library-state.service.ts`, near other backend-related signals (`backendLoading`, `backendError`, `backendEmpty`):

```typescript
  readonly pickerVisible = signal(false);

  openLibraryPicker(): void {
    this.pickerVisible.set(true);
  }

  closeLibraryPicker(): void {
    this.pickerVisible.set(false);
  }
```

Also update `addLibraryFolder` to call `closeLibraryPicker()` before `loadFolderTree()` on success — when the user picks via the modal, the modal should dismiss as soon as registration completes.

- [ ] **Step 2.2: Spec — pickerVisible round-trip**

Add to `library-state.service.spec.ts` inside the existing top-level describe:

```typescript
  describe('library picker visibility', () => {
    it('toggles via openLibraryPicker / closeLibraryPicker', () => {
      expect(service.pickerVisible()).toBe(false);
      service.openLibraryPicker();
      expect(service.pickerVisible()).toBe(true);
      service.closeLibraryPicker();
      expect(service.pickerVisible()).toBe(false);
    });

    it('addLibraryFolder closes the picker on success', () => {
      service.openLibraryPicker();
      expect(service.pickerVisible()).toBe(true);
      service.addLibraryFolder('/photos');
      // The existing ApiStub returns a successful folder synchronously, so
      // the picker should be closed by the time addLibraryFolder returns.
      // Match the pattern in the existing addLibraryFolder tests.
      expect(service.pickerVisible()).toBe(false);
    });
  });
```

(If the existing test harness returns Observables that need to be flushed manually, mirror that pattern. Read the existing `addLibraryFolder` tests for the exact incantation.)

Run the spec — confirm the new tests fail, implement, confirm they pass.

- [ ] **Step 2.3: Build the modal wrapper component**

```typescript
// src/web/projects/maple-common/src/lib/components/library-picker-modal/library-picker-modal.component.ts
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryPickerComponent } from '../library-picker/library-picker.component';

@Component({
  selector: 'app-library-picker-modal',
  standalone: true,
  imports: [LibraryPickerComponent],
  templateUrl: './library-picker-modal.component.html',
  styleUrl: './library-picker-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPickerModalComponent {
  readonly state = inject(LibraryStateService);

  onPick(absPath: string): void {
    this.state.addLibraryFolder(absPath);
    // addLibraryFolder closes the picker on success; on failure it stays open
    // so the user can adjust.
  }

  onCancel(): void {
    this.state.closeLibraryPicker();
  }

  onBackdropClick(): void {
    this.state.closeLibraryPicker();
  }
}
```

```html
<!-- library-picker-modal.component.html -->
@if (state.pickerVisible()) {
  <div class="backdrop" (click)="onBackdropClick()">
    <div class="dialog" (click)="$event.stopPropagation()">
      <app-library-picker
        (pick)="onPick($event)"
        (cancel)="onCancel()"
      />
    </div>
  </div>
}
```

```scss
// library-picker-modal.component.scss
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dialog {
  max-width: 600px;
  width: 100%;
  display: flex;
}
```

Add the `LibraryPickerModalComponent` export to `public-api.ts`:
```typescript
export * from './lib/components/library-picker-modal/library-picker-modal.component';
```

- [ ] **Step 2.4: Add "+" button to FolderTree header**

Read `folder-tree.component.html` first to find where the section header / title sits. Add a small "+" icon button:

```html
<button
  class="add-folder-btn"
  type="button"
  title="Add a folder to your library"
  (click)="state.openLibraryPicker()"
  aria-label="Add folder"
>+</button>
```

If `state` isn't already injected in `FolderTreeComponent`, add `readonly state = inject(LibraryStateService)`. Style the button to match the existing chrome (small, subtle).

- [ ] **Step 2.5: Mount the modal at root**

In `browse-shell.component.html`, add `<app-library-picker-modal />` at the root level (sibling to `<div class="window">`, after it). Import `LibraryPickerModalComponent` in `browse-shell.component.ts` `imports: [...]`.

- [ ] **Step 2.6: Build + smoke**

```bash
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng build maple-common --configuration=development 2>&1 | tail -10
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng build maple-self-hosted --configuration=development 2>&1 | tail -10
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless 2>&1 | tail -10
```

Both builds and the test suite green.

- [ ] **Step 2.7: Commit**

```bash
git add src/web/projects/maple-common/src/lib/state/library-state.service.ts \
        src/web/projects/maple-common/src/lib/state/library-state.service.spec.ts \
        src/web/projects/maple-common/src/lib/components/library-picker-modal \
        src/web/projects/maple-common/src/lib/components/folder-tree \
        src/web/projects/maple-common/src/lib/shells/browse-shell \
        src/web/projects/maple-common/src/public-api.ts
git commit -m "feat(maple-common): add 'Add folder' button + picker modal

The picker now also opens as a centered modal from a '+' button in the
folder-tree header, so users can register additional libraries after
first-run, not only from the empty state."
```

---

## Task 3: Indexer admin panel (polling)

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts`
- Create: `src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.{ts,html,scss,spec.ts}`
- Modify: `src/web/projects/maple-common/src/lib/state/library-state.service.ts` — add `adminVisible` signal
- Modify: `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.{ts,html,scss}` — status button + mount modal
- Modify: `src/web/projects/maple-common/src/public-api.ts`

- [ ] **Step 3.1: Extend `BunApiBackendService` with indexer methods**

Add these interfaces near the existing ones:

```typescript
export type IndexerStage = 'discover' | 'hash' | 'exif' | 'thumb' | 'ai' | 'mongo';

export interface IndexerStageCounters {
  inFlight: number;
  errors: number;
  deadLetter: number;
}

export interface IndexerChannelInfo {
  depth: number;
  capacity: number;
}

export interface IndexerStatus {
  paused: boolean;
  pools: Record<IndexerStage, number>;
  channels: Record<IndexerStage, IndexerChannelInfo>;
  stages: Record<IndexerStage, IndexerStageCounters>;
}

export interface IndexerDeadLetterItem {
  id?: string;
  stage: string;
  jobId?: string;
  absPath?: string;
  error?: string;
  attempts?: number;
  failedAt?: string;
}

export interface IndexerDeadLetterPage {
  items: IndexerDeadLetterItem[];
  total: number;
  warning?: string;
}
```

Add these methods on the service:

```typescript
  getIndexerStatus(): Observable<IndexerStatus> {
    return this.http.get<IndexerStatus>(`${this.base}/indexer/status`);
  }

  setIndexerWorkers(workers: Partial<Record<IndexerStage, number>>): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.put<{ ok: boolean; status: IndexerStatus }>(
      `${this.base}/indexer/config`,
      { workers },
    );
  }

  pauseIndexer(): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(`${this.base}/indexer/pause`, {});
  }

  resumeIndexer(): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(`${this.base}/indexer/resume`, {});
  }

  listDeadLetter(limit = 200): Observable<IndexerDeadLetterPage> {
    let params = new HttpParams().set('limit', String(limit));
    return this.http.get<IndexerDeadLetterPage>(`${this.base}/indexer/dead-letter`, { params });
  }
```

- [ ] **Step 3.2: Add `adminVisible` signal to state service**

In `library-state.service.ts`, near `pickerVisible`:

```typescript
  readonly adminVisible = signal(false);
  openIndexerAdmin(): void { this.adminVisible.set(true); }
  closeIndexerAdmin(): void { this.adminVisible.set(false); }
```

(No tests required — trivial signal, exercised via the component spec.)

- [ ] **Step 3.3: Build the admin component**

```typescript
// src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.ts
import {
  ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal,
} from '@angular/core';
import { Subscription, interval, switchMap, startWith } from 'rxjs';
import {
  BunApiBackendService,
  type IndexerStage,
  type IndexerStatus,
  type IndexerDeadLetterItem,
} from '../../api/bun-api-backend.service';

const STAGES: IndexerStage[] = ['discover', 'hash', 'exif', 'thumb', 'ai', 'mongo'];

@Component({
  selector: 'app-indexer-admin',
  standalone: true,
  templateUrl: './indexer-admin.component.html',
  styleUrl: './indexer-admin.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IndexerAdminComponent implements OnInit, OnDestroy {
  private readonly api = inject(BunApiBackendService);

  readonly stages = STAGES;
  readonly status = signal<IndexerStatus | null>(null);
  readonly deadLetter = signal<IndexerDeadLetterItem[]>([]);
  readonly error = signal<string | null>(null);

  private sub?: Subscription;

  ngOnInit(): void {
    // Poll every 2 seconds while open; live WS upgrade in Task 4.
    this.sub = interval(2000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.getIndexerStatus()),
      )
      .subscribe({
        next: (s) => { this.status.set(s); this.error.set(null); },
        error: (e) => this.error.set(e?.error?.error ?? e?.message ?? 'Status failed.'),
      });

    this.api.listDeadLetter(50).subscribe({
      next: (p) => this.deadLetter.set(p.items),
      error: () => this.deadLetter.set([]),
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  togglePause(): void {
    const cur = this.status();
    if (!cur) return;
    const obs = cur.paused ? this.api.resumeIndexer() : this.api.pauseIndexer();
    obs.subscribe({ next: (r) => this.status.set(r.status) });
  }

  setPool(stage: IndexerStage, value: number): void {
    this.api.setIndexerWorkers({ [stage]: value }).subscribe({
      next: (r) => this.status.set(r.status),
    });
  }

  channelPct(stage: IndexerStage): number {
    const ch = this.status()?.channels[stage];
    if (!ch || ch.capacity === 0) return 0;
    return Math.round((ch.depth / ch.capacity) * 100);
  }
}
```

```html
<!-- indexer-admin.component.html -->
<div class="admin">
  <header>
    <h2>Indexer</h2>
    @if (status(); as s) {
      <button class="pause-btn" type="button" (click)="togglePause()">
        {{ s.paused ? '▶ Resume' : '⏸ Pause' }}
      </button>
    }
  </header>

  @if (error(); as e) {
    <div class="error">{{ e }}</div>
  }

  @if (status(); as s) {
    <table class="stages">
      <thead>
        <tr><th>Stage</th><th>Workers</th><th>In flight</th><th>Errors</th><th>Channel</th></tr>
      </thead>
      <tbody>
        @for (st of stages; track st) {
          <tr>
            <td class="name">{{ st }}</td>
            <td class="workers">
              <input type="range" min="1" max="32" [value]="s.pools[st]"
                (change)="setPool(st, +$any($event.target).value)" />
              <span>{{ s.pools[st] }}</span>
            </td>
            <td>{{ s.stages[st].inFlight }}</td>
            <td [class.warn]="s.stages[st].errors > 0">{{ s.stages[st].errors }}</td>
            <td class="channel">
              <div class="bar"><div class="fill" [style.width.%]="channelPct(st)"></div></div>
              <span>{{ s.channels[st].depth }} / {{ s.channels[st].capacity }}</span>
            </td>
          </tr>
        }
      </tbody>
    </table>
  } @else {
    <div class="loading">Loading…</div>
  }

  @if (deadLetter().length > 0) {
    <section class="dead-letter">
      <h3>Dead-letter ({{ deadLetter().length }})</h3>
      <ul>
        @for (it of deadLetter(); track it.jobId ?? it.absPath ?? $index) {
          <li>
            <span class="dl-stage">{{ it.stage }}</span>
            <span class="dl-path">{{ it.absPath || it.jobId }}</span>
            <span class="dl-err">{{ it.error }}</span>
          </li>
        }
      </ul>
    </section>
  }
</div>
```

```scss
// indexer-admin.component.scss
:host {
  display: block;
  background: var(--maple-bg-elev, #2c2c2e);
  color: var(--maple-text-main, #f2f2f7);
  padding: 24px;
  border-radius: 8px;
  width: 720px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
}
header { display: flex; justify-content: space-between; align-items: center; }
header h2 { margin: 0; font-size: 16px; }
.pause-btn { padding: 4px 12px; font-size: 12px; }
.error { background: rgba(255, 80, 80, 0.15); padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 12px; color: var(--maple-text-err, #ff6b6b); }

.stages { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
.stages th, .stages td { padding: 6px 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.06); }
.stages th { color: var(--maple-text-muted, #999); font-weight: 500; }
.stages td.name { font-family: ui-monospace, monospace; }
.stages td.workers { display: flex; gap: 6px; align-items: center; }
.stages td.workers input { width: 100px; }
.stages td.warn { color: var(--maple-text-err, #ff6b6b); }
.channel { display: flex; gap: 8px; align-items: center; }
.bar { width: 100px; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden; }
.fill { height: 100%; background: var(--maple-accent, #4a8fea); }

.dead-letter { margin-top: 16px; }
.dead-letter h3 { margin: 0 0 8px 0; font-size: 13px; color: var(--maple-text-muted, #999); }
.dead-letter ul { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow-y: auto; }
.dead-letter li { display: grid; grid-template-columns: 80px 1fr 1fr; gap: 8px; padding: 4px 0; font-size: 11px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.dl-stage { color: var(--maple-text-muted, #999); }
.dl-path { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-err { color: var(--maple-text-err, #ff6b6b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.loading { padding: 24px; text-align: center; color: var(--maple-text-muted, #999); }
```

- [ ] **Step 3.4: Component spec**

```typescript
// indexer-admin.component.spec.ts
import { ComponentFixture, TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { IndexerAdminComponent } from './indexer-admin.component';
import { API_BASE_URL } from '../../api/api-base-url.token';

const STATUS_RUNNING = {
  paused: false,
  pools: { discover: 4, hash: 2, exif: 4, thumb: 2, ai: 1, mongo: 8 },
  channels: {
    discover: { depth: 0, capacity: 256 }, hash: { depth: 1, capacity: 256 },
    exif: { depth: 0, capacity: 256 }, thumb: { depth: 3, capacity: 128 },
    ai: { depth: 0, capacity: 256 }, mongo: { depth: 0, capacity: 256 },
  },
  stages: {
    discover: { inFlight: 0, errors: 0, deadLetter: 0 },
    hash: { inFlight: 1, errors: 0, deadLetter: 0 },
    exif: { inFlight: 0, errors: 0, deadLetter: 0 },
    thumb: { inFlight: 2, errors: 0, deadLetter: 0 },
    ai: { inFlight: 0, errors: 0, deadLetter: 0 },
    mongo: { inFlight: 0, errors: 0, deadLetter: 0 },
  },
};

describe('IndexerAdminComponent', () => {
  let fixture: ComponentFixture<IndexerAdminComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [IndexerAdminComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    fixture = TestBed.createComponent(IndexerAdminComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('fetches status on init and renders the stages table', () => {
    http.expectOne((r) => r.url === '/api/indexer/status').flush(STATUS_RUNNING);
    http.expectOne((r) => r.url === '/api/indexer/dead-letter').flush({ items: [], total: 0 });
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.stages tbody tr');
    expect(rows.length).toBe(6);
    expect(fixture.nativeElement.querySelector('.pause-btn').textContent).toContain('Pause');
  });

  it('togglePause posts /pause when running', () => {
    http.expectOne('/api/indexer/status').flush(STATUS_RUNNING);
    http.expectOne((r) => r.url === '/api/indexer/dead-letter').flush({ items: [], total: 0 });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.pause-btn') as HTMLButtonElement).click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/indexer/pause');
    post.flush({ ok: true, status: { ...STATUS_RUNNING, paused: true } });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pause-btn').textContent).toContain('Resume');
  });

  it('setPool PUTs /config when slider changes', () => {
    http.expectOne('/api/indexer/status').flush(STATUS_RUNNING);
    http.expectOne((r) => r.url === '/api/indexer/dead-letter').flush({ items: [], total: 0 });
    fixture.detectChanges();

    fixture.componentInstance.setPool('thumb', 6);
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/indexer/config');
    expect(put.request.body).toEqual({ workers: { thumb: 6 } });
    put.flush({ ok: true, status: { ...STATUS_RUNNING, pools: { ...STATUS_RUNNING.pools, thumb: 6 } } });
  });
});
```

Run, fail, then we already have the impl from Step 3.3 — re-run, pass.

- [ ] **Step 3.5: Wire into BrowseShell titlebar**

In `browse-shell.component.html`, find the titlebar (the `.titlebar` div with the chrome-btns). Add a status button between the search button and the spacer:

```html
<div
  class="chrome-btn"
  title="Indexer status"
  (click)="state.openIndexerAdmin()"
  aria-label="Open indexer admin"
>
  <maple-icon name="activity" [size]="13" color="var(--maple-text-muted)" />
</div>
```

(If `name="activity"` doesn't exist in the icon set, pick the closest existing one — `pulse`, `gauge`, `chart`, `gear`. Read the icon component to find what's available; commit a small icon addition if nothing fits, or use a text label like `"Indexer"`.)

Add the modal at root level (alongside the picker modal added in Task 2):

```html
@if (state.adminVisible()) {
  <div class="backdrop" (click)="state.closeIndexerAdmin()">
    <div class="dialog" (click)="$event.stopPropagation()">
      <app-indexer-admin />
      <button class="dialog-close" (click)="state.closeIndexerAdmin()">Close</button>
    </div>
  </div>
}
```

(Or factor the backdrop+dialog into a small reusable wrapper if doing it twice feels too repetitive — judgment call.)

Add `IndexerAdminComponent` import to `browse-shell.component.ts` `imports: [...]`.

- [ ] **Step 3.6: Build + test**

```bash
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng build maple-common --configuration=development 2>&1 | tail -10
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless 2>&1 | tail -10
```

- [ ] **Step 3.7: Commit**

```bash
git add src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts \
        src/web/projects/maple-common/src/lib/state/library-state.service.ts \
        src/web/projects/maple-common/src/lib/components/indexer-admin \
        src/web/projects/maple-common/src/lib/shells/browse-shell \
        src/web/projects/maple-common/src/public-api.ts
git commit -m "feat(maple-common): indexer admin panel with pause + per-stage worker sliders

Polls /api/indexer/status every 2s while open. Shows per-stage worker
count (slider, 1-32), in-flight, errors, channel depth/capacity.
Pause/resume button. Dead-letter list. Mounted as a modal from a
status button in the BrowseShell titlebar.

Live WS-driven updates land in the next commit."
```

---

## Task 4: Live WebSocket updates

**Files:**
- Create: `src/web/projects/maple-common/src/lib/services/indexer-events.service.ts`
- Test: `src/web/projects/maple-common/src/lib/services/indexer-events.service.spec.ts`
- Modify: `src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.ts`

The server already has `WS /api/events` from the Self-Hosted backend (see `src/api/src/routes/events.ts`). It emits a snapshot on connect, then 250ms-throttled progress updates and filesystem-watch events. We tap into it.

- [ ] **Step 4.1: Spec the events service**

```typescript
// indexer-events.service.spec.ts
import { TestBed } from '@angular/core/testing';
import { IndexerEventsService } from './indexer-events.service';

describe('IndexerEventsService', () => {
  let service: IndexerEventsService;
  let originalWS: typeof WebSocket;
  const sockets: FakeSocket[] = [];

  class FakeSocket {
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
    (globalThis as any).WebSocket = FakeSocket;
    TestBed.configureTestingModule({});
    service = TestBed.inject(IndexerEventsService);
  });

  afterEach(() => { (globalThis as any).WebSocket = originalWS; });

  it('connects on first connect() call and exposes status$ updates', (done) => {
    service.connect();
    expect(sockets.length).toBe(1);

    const sub = service.status$.subscribe((s) => {
      if (s) {
        expect(s.paused).toBe(false);
        sub.unsubscribe();
        service.disconnect();
        done();
      }
    });

    sockets[0].onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ type: 'status', status: { paused: false, pools: {}, channels: {}, stages: {} } }),
    }));
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
```

- [ ] **Step 4.2: Implement the events service**

```typescript
// indexer-events.service.ts
import { Injectable, signal } from '@angular/core';
import { Observable, ReplaySubject } from 'rxjs';
import type { IndexerStatus } from '../api/bun-api-backend.service';

@Injectable({ providedIn: 'root' })
export class IndexerEventsService {
  private socket: WebSocket | null = null;
  private subject = new ReplaySubject<IndexerStatus | null>(1);
  readonly status$: Observable<IndexerStatus | null> = this.subject.asObservable();
  readonly connected = signal(false);

  connect(): void {
    if (this.socket) return;
    const url = this.endpoint();
    this.socket = new WebSocket(url);
    this.socket.onopen = () => this.connected.set(true);
    this.socket.onclose = () => { this.connected.set(false); this.socket = null; };
    this.socket.onerror = () => { this.connected.set(false); };
    this.socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg && msg.type === 'status' && msg.status) {
          this.subject.next(msg.status as IndexerStatus);
        }
      } catch {
        // Ignore malformed frames.
      }
    };
  }

  disconnect(): void {
    if (!this.socket) return;
    try { this.socket.close(); } catch { /* noop */ }
    this.socket = null;
    this.connected.set(false);
  }

  private endpoint(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/events`;
  }
}
```

(If the server's events stream uses a different message shape — the existing `events.ts` route emits `{ type: 'progress', ... }` and filesystem events — adapt the `onmessage` parser to what's actually emitted. Read `src/api/src/routes/events.ts` first; you may need a thin server-side change to emit a `{ type: 'status' }` snapshot frame periodically. If you do change the server, add a follow-up commit and a server test.)

- [ ] **Step 4.3: Swap the polling loop in IndexerAdmin for the WS subscription**

In `indexer-admin.component.ts`:

(a) Inject `IndexerEventsService`.
(b) In `ngOnInit`, call `events.connect()` and subscribe to `events.status$` instead of polling. Keep one `getIndexerStatus()` HTTP call as the initial seed in case the WS is slow.
(c) In `ngOnDestroy`, call `events.disconnect()`.

Updated `ngOnInit` shape:

```typescript
  ngOnInit(): void {
    this.api.getIndexerStatus().subscribe({
      next: (s) => { this.status.set(s); this.error.set(null); },
      error: (e) => this.error.set(e?.error?.error ?? e?.message ?? 'Status failed.'),
    });
    this.events.connect();
    this.sub = this.events.status$.subscribe((s) => {
      if (s) this.status.set(s);
    });

    this.api.listDeadLetter(50).subscribe({
      next: (p) => this.deadLetter.set(p.items),
      error: () => this.deadLetter.set([]),
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.events.disconnect();
  }
```

Drop the `interval(2000)` import and usage.

- [ ] **Step 4.4: Update the admin component spec**

The existing spec in Task 3 used the polling pattern. Update it: provide a fake `IndexerEventsService` (or inject the real one with `provideHttpClient` etc.) and emit a `status` to trigger updates. Or simpler: keep the seed `getIndexerStatus()` HTTP call (HttpTestingController flushes that), and verify the component renders from the seed without depending on WS.

- [ ] **Step 4.5: Build + test**

```bash
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng test maple-common --watch=false --browsers=ChromeHeadless 2>&1 | tail -10
cd /Users/riabuz/Projects/_Maple/src/web && bun x ng build maple-self-hosted --configuration=development 2>&1 | tail -10
```

- [ ] **Step 4.6: Commit**

```bash
git add src/web/projects/maple-common/src/lib/services/indexer-events.service.ts \
        src/web/projects/maple-common/src/lib/services/indexer-events.service.spec.ts \
        src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.ts \
        src/web/projects/maple-common/src/lib/components/indexer-admin/indexer-admin.component.spec.ts
git commit -m "feat(maple-common): live WS subscription for indexer admin

Replaces the 2-second polling loop with a WebSocket subscription to
/api/events. Initial HTTP seed kept so the panel paints immediately
even if WS handshake is slow."
```

---

## Self-Review Notes

**Spec coverage:**
- ✓ Add new folders later — Task 2 modal + button
- ✓ Browse them — already shipped via prior plan (folder tree + asset grid)
- ✓ Watch worker status — Task 3 admin panel
- ✓ Pause workers — Task 1 backend + Task 3 toggle
- ✓ Live updates — Task 4 WS subscription

**Open uncertainties:**
- Task 4 may require a tiny server-side tweak to `src/api/src/routes/events.ts` if the current frame shape isn't `{ type: 'status', status: ... }`. The implementer should read the server first and either adapt the client parser or add a single-line server change with a test.
- Icon name in Task 3.5 (`activity`) — may not exist; the implementer picks an available icon or adds one.
