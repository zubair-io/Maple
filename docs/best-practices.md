# Maple — Best Practices

Coding standards and patterns for Maple across Angular (web), Swift (Apple), and Rust (shared core). These are conventions the team agreed on — follow them by default, deviate with a PR comment explaining why.

The bar is: a working photographer can trust the color, and the slider responds inside a single 60Hz frame. Code that sacrifices either is not ready to merge.

---

## Guiding principles

These sit above every pattern below. When in doubt, fall back to these.

### 1. Don't reinvent the wheel

If the platform provides a primitive that does what you need, use it. `CIContext`, Angular's `HttpClient`, Rust's `rayon`, `NSCache`, IndexedDB — these are production-hardened by large teams and we can't do better. "I could write a faster one" is almost always false, and even when it's true it's not worth the maintenance.

What counts as "the wheel":

- HTTP with caching and interceptors → `HttpClient`, not `fetch`.
- In-memory LRU → `NSCache` on Apple, a small Map-based LRU on web (or the service worker cache for HTTP).
- Offline-ready asset storage on web → IndexedDB via a minimal wrapper (Dexie or `idb`), not raw `IDBRequest`.
- Async primitives in Rust → `rayon` for CPU parallelism, `tokio` only if we genuinely need I/O scheduling (we usually don't in the core).
- GPU tiling → our own tile planner in Rust (shared across platforms), not per-platform reimplementations.

What does _not_ count: color science. We write the color math from first principles, against published references, with pixel-parity gates. No shortcuts there.

### 2. Keep it simple

- Only make changes that are directly requested.
- Don't add features beyond what was asked.
- Don't add abstractions for hypothetical future requirements.
- Don't add error handling for impossible scenarios.
- Don't add feature flags unless shipping the feature behind one.
- Three lines of clear code beats a premature abstraction.

```typescript
// Good — simple, obvious
const name = user.name;
const email = user.email;
const createdAt = user.createdAt;

// Avoid — "clever" but unreadable
const extract = <T, K extends keyof T>(obj: T, fields: K[]): Pick<T, K> =>
  fields.reduce((acc, f) => ({ ...acc, [f]: obj[f] }), {} as Pick<T, K>);
```

### 3. Small functional chunks

Every function does one thing. Every component renders one thing. Every service owns one concern. When a function grows past ~40 lines or a component past ~150, split it.

- A component that renders chat _and_ a note editor _and_ a lego grid is three components, wired together by a route.
- A service that authenticates users _and_ fetches notebooks _and_ uploads thumbnails is three services.
- A pipeline stage that demosaics _and_ applies white balance is two stages.

### 4. Reactive by default — observables at the service layer, view models in components

On the web, all async data flows through observables. Services expose `Observable<T>` from their public methods. Components build a view model — a small bundle of observables, signals, and computed values — and subscribe via `async` pipe or `toSignal()`. We do not `await` observables at the service boundary.

See `§ Angular — Observables and view models` below for the pattern in detail.

### 5. Performance is a feature

- Slider tick: 16ms target, 50ms hard limit.
- No allocation inside the render loop.
- Cache before you compute. Compute before you re-fetch.
- Measure with the color-pipeline harness and the browser's performance profiler. Don't guess.

---

## Code formatting

Prettier handles all formatting. Editor must format on save.

```json
// src/web/.prettierrc — the config CI uses (everything else is Prettier defaults)
{
  "printWidth": 100,
  "singleQuote": true,
  "overrides": [{ "files": "*.html", "options": { "parser": "angular" } }]
}
```

```bash
cd src/web
bun run format          # prettier --write over files your branch changes vs origin/main
bun run format:check    # the CI gate (cross.yml format-check): --check over the same files
```

There is no web lint step — Prettier is the only TypeScript/HTML style gate; CI (`.github/workflows/cross.yml`) runs it over the files a PR changes, repo-wide (`src/api` and `docs/` included).

**Do not manually format code.** If Prettier output looks wrong, fix Prettier config — don't fight the tool.

Swift uses `swift-format` with the repo config. Rust uses `rustfmt` defaults. Same rule: let the tool win.

---

## TypeScript

### Strict mode, no exceptions

```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true
  }
}
```

### `import type` for type-only imports

```typescript
// Good
import type { User, Notebook } from '@maple/shared';
import { validateUser } from '@maple/shared';

// Bad
import { User, Notebook, validateUser } from '@maple/shared';
```

### Never `any` — use `unknown` and narrow

```typescript
// Bad
function processData(data: any) {
  return data.name;
}

// Good
function processData(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'name' in data) {
    return String(data.name);
  }
  throw new Error('Invalid data');
}
```

### Prefer type guards over assertions

```typescript
function isUser(obj: unknown): obj is User {
  return typeof obj === 'object' && obj !== null && 'email' in obj && '_id' in obj;
}

// Use assertions only when absolutely necessary, with a comment explaining why.
const user = data as User; // narrowed by upstream validator
```

### Utility types

`Partial`, `Pick`, `Omit`, `Required`, `Readonly`, `NonNullable` — prefer these over writing new interfaces for trivially derived shapes.

---

## Angular

### Every component is three files

```
button/
├── maple-button.component.ts       # Component class — logic only
├── maple-button.component.html     # Template
└── maple-button.component.scss     # Styles
```

Almost always TS + HTML + SCSS as separate files. No inline templates beyond a single `<ng-content />` sketch. No inline styles in `styleUrls`. SCSS is empty until it's not — create it anyway so the structure is consistent.

### Standalone components, always

```typescript
@Component({
  selector: 'app-button',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './button.component.html',
  styleUrl: './button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ButtonComponent {}
```

`ChangeDetectionStrategy.OnPush` is the default. With signals and observables, we almost never need Zone-triggered change detection.

### `input()` / `output()` — function syntax only

```typescript
// Good
readonly variant = input<'primary' | 'secondary'>('primary');
readonly disabled = input<boolean>(false);
readonly clicked = output<void>();

// Bad — decorator syntax is legacy
@Input() variant: 'primary' | 'secondary' = 'primary';
@Output() clicked = new EventEmitter<void>();
```

### `inject()` for dependency injection

```typescript
// Good
export class EditorComponent {
  private readonly editSession = inject(EditSessionService);
  private readonly router = inject(Router);
}

// Avoid
export class EditorComponent {
  constructor(
    private editSession: EditSessionService,
    private router: Router,
  ) {}
}
```

### Control flow syntax

```html
<!-- Good -->
@if (isLoading()) {
<app-spinner />
} @else if (error()) {
<app-error [message]="error()" />
} @else {
<div>Content</div>
} @for (item of items(); track item.id) {
<app-item [data]="item" />
} @empty {
<p>No items found</p>
}

<!-- Bad — structural directives are legacy -->
<app-spinner *ngIf="isLoading"></app-spinner>
<div *ngFor="let item of items">...</div>
```

### Signals for local state

```typescript
// Good — signals for synchronous local state
readonly count = signal(0);
readonly doubled = computed(() => this.count() * 2);

increment(): void {
    this.count.update(c => c + 1);
}

// Bad — BehaviorSubject in a component for local state
private countSubject = new BehaviorSubject(0);
count$ = this.countSubject.asObservable();
```

### Page-level separation

Each page component owns one concern. Never switch page content with `@if` inside a parent. Use `canMatch` route guards instead.

```typescript
// Good
// chat-view.component.ts — only chat
// note-view.component.ts — only notes
// lego-view.component.ts — only lego

// Bad
@if (viewType === 'chat') {
    <app-chat />
} @else if (viewType === 'note') {
    <app-note-editor />
}
```

### Routing & Navigation

1. **SPA Integrity:** Always use `routerLink` / `[routerLink]` rather than standard `href` / `[href]` for internal navigation (e.g. settings panels, worker pages, profile pages). Standard `href` triggers a full browser reload, which resets the Angular state and breaks browser history navigation.
2. **Browser History Management:**
   - Avoid using `replaceUrl: true` for normal master-detail / page transitions. Users expect the browser back button to navigate backwards sequentially through their page views.
   - Only use `replaceUrl: true` for:
     - Boot-level or guard redirects (e.g. `/` redirecting to `/browse` or authentication redirects).
     - Close/dismiss action buttons (e.g., closing a detail panel so that browser Back does not trap the user inside the detail view).
     - Reactive URL synchronization for search inputs or dynamic state parameters (e.g. updating `?q=` as the user types), to avoid filling the history stack with intermediate query states.

---

## Angular — observables and view models

This is the pattern that changes most from our earlier codebases. We are moving _away_ from `firstValueFrom` + `await`, and toward pure-observable service layers with component-level view models.

### Services return `Observable<T>`

Never `firstValueFrom`, never `toPromise`. Services are thin wrappers around `HttpClient` (or WASM calls wrapped with `from()`). They expose observables, and only observables.

```typescript
// Good
@Injectable({ providedIn: 'root' })
export class NotebookService {
    private readonly http = inject(HttpClient);

    list(): Observable<Notebook[]> {
        return this.http.get<Notebook[]>('/api/notebooks');
    }

    get(id: string): Observable<Notebook> {
        return this.http.get<Notebook>(`/api/notebooks/${id}`);
    }

    create(data: CreateNotebookDto): Observable<Notebook> {
        return this.http.post<Notebook>('/api/notebooks', data);
    }
}

// Bad — leaks promises into callers
async list(): Promise<Notebook[]> {
    return firstValueFrom(this.http.get<Notebook[]>('/api/notebooks'));
}
```

### State services expose observables backed by `BehaviorSubject`

For session-scoped state (the current notebook, the current edit session, the auth user), wrap a `BehaviorSubject` and expose it as an observable.

```typescript
@Injectable({ providedIn: 'root' })
export class EditSessionService {
  private readonly sessionSubject = new BehaviorSubject<EditSession | null>(null);
  readonly session$ = this.sessionSubject.asObservable();

  readonly adjustments$: Observable<AdjustmentModel | null> = this.session$.pipe(
    map((s) => s?.adjustments ?? null),
    distinctUntilChanged(),
  );

  open(asset: ImageAsset): Observable<EditSession> {
    return this.loadSidecar(asset).pipe(
      map((sidecar) => EditSession.from(asset, sidecar)),
      tap((session) => this.sessionSubject.next(session)),
    );
  }

  updateAdjustment<K extends keyof AdjustmentModel>(key: K, value: AdjustmentModel[K]): void {
    const current = this.sessionSubject.value;
    if (!current) return;
    this.sessionSubject.next({
      ...current,
      adjustments: { ...current.adjustments, [key]: value },
    });
  }
}
```

### Components build a view model

A view model is a small object, created once in the component, that bundles the observables and signals the template needs. The template reads from the view model via `async` pipe or `toSignal()`.

```typescript
@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [AsyncPipe, ColorPanelComponent, HistogramComponent],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorComponent {
  private readonly editSession = inject(EditSessionService);
  private readonly histogram = inject(HistogramService);

  protected readonly vm = this.buildViewModel();

  private buildViewModel() {
    const session$ = this.editSession.session$;
    const adjustments$ = this.editSession.adjustments$;
    const histogram$ = adjustments$.pipe(
      debounceTime(150),
      switchMap((adj) => (adj ? this.histogram.compute(adj) : of(null))),
    );

    return {
      // Signals for synchronous, template-accessed values
      isReady: toSignal(session$.pipe(map((s) => s !== null)), {
        initialValue: false,
      }),

      // Observables for async-pipe use in templates
      adjustments$,
      histogram$,
    } as const;
  }

  onExposureChange(value: number): void {
    this.editSession.updateAdjustment('exposure', value);
  }
}
```

```html
<!-- editor.component.html -->
@if (vm.isReady()) { @if (vm.adjustments$ | async; as adj) {
<app-color-panel [adjustments]="adj" (exposureChange)="onExposureChange($event)" />
} @if (vm.histogram$ | async; as histogram) {
<app-histogram [data]="histogram" />
} }
```

### Why this pattern

- **Cancellation is free.** A new slider tick cancels the in-flight histogram computation via `switchMap`. Promises require manual `AbortController` plumbing for the same behavior.
- **Composition is declarative.** `debounceTime`, `distinctUntilChanged`, `combineLatest`, `switchMap` compose the way the UI actually behaves. Promises compose poorly past two steps.
- **Memory lifecycle is handled by `async` pipe.** No manual `unsubscribe`, no `takeUntilDestroyed` sprinkled across the component.
- **Change detection is minimal.** `OnPush` + `async` pipe + signals means the framework only re-checks components whose inputs actually changed.

### When a promise is OK

- One-shot imperative actions: `router.navigate()`, file downloads, logging, analytics.
- Interop with libraries that only expose promises (wrap with `from()` at the boundary).
- Inside effects, wrap with `from()` to bring back into the observable world.

---

## Styling

### Tailwind first, design tokens always

Tailwind utility classes are the primary styling method. Arbitrary values reference CSS variables from the design system.

```html
<button
  class="px-4 py-2 bg-[var(--color-accent)] text-white rounded-md
           hover:bg-[var(--color-accent-hover)] transition-colors
           disabled:opacity-50 disabled:cursor-not-allowed"
>
  Submit
</button>
```

The design tokens (`src/web/projects/maple-common/src/lib/tokens.scss`) are the single source of truth for color, typography, spacing, and elevation. Hex values are authored in `src/raw-pipeline/raw-core/src/ui_tokens.rs` and emitted into `src/web/projects/maple-common/src/lib/generated/_ui-tokens.scss` by `tools/codegen.sh`; `tokens.scss` wires those into the Tailwind `@theme` block and SCSS aliases. Hex values do not appear in component templates or SCSS. If you need a color, add a token first.

Key rules for Maple's dark theme:

- **Never pure black.** Root background is warm charcoal `var(--color-bg-root)` (`#1c1917`).
- **Elevation = lighter warm surfaces**, not shadows.
- **Accent `var(--color-accent)` is used sparingly** — selected nav, active tab indicator, focus rings, XMP badge border. Never as a fill on large surfaces.
- **Scopes always render on `var(--color-bg-scope)`** (`#141210`, deeper than root) so RGB waveform colors read clearly.
- **Images are the UI.** Chrome recedes; thumbnails and the full-image view dominate visual weight.

### SCSS is for what Tailwind can't express

- Complex animations with multiple keyframes
- `::before` / `::after` pseudo-elements
- Compound selectors that depend on structural state

```scss
// button.component.scss
.button {
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background: currentColor;
    opacity: 0;
    transition: opacity 0.2s;
  }

  &:hover::after {
    opacity: 0.1;
  }
}
```

### Never inline styles

```html
<!-- Bad -->
<div style="color: red; margin: 10px;">
  <!-- Good -->
  <div class="text-[var(--color-danger)] m-2.5"></div>
</div>
```

---

## Caching strategy

Maple is a cache-heavy app by design — the alternative (re-decoding a 100MP RAW on every view) is not acceptable. Caching lives at every layer.

### Web — the three layers

1. **Angular service worker** (`ngsw-config.json`). Caches the app shell, static assets, and API responses with appropriate freshness strategies. Configured with `performance` strategy for static assets (cache-first) and `freshness` strategy for data APIs (network-first with fallback). The service worker is what makes the editor load in one frame on a repeat visit.

2. **IndexedDB** via a minimal wrapper (`idb` library — ~2KB gzipped, no opinions). Used for:
   - **Rendered preview cache.** Keyed on `(primaryUrl, primaryMtime, sidecarMtime, screenSize, adjustmentVersion, viewTransformVersion)`. Stores JPEG bytes. Cold-open hit returns pixels in ~35ms.
   - **Thumbnail disk cache.** Keyed on `(assetId, size)`. Persistent across sessions.
   - **Remote source bytes.** Cached RAW file bytes, keyed on remote path + mtime. We never re-download a RAW we've seen.

3. **In-memory** via `BehaviorSubject`, signals, or a small Map-based LRU for hot paths. Session-scoped. The decoded scene-linear f32 buffer lives here — exactly one per open `EditSession`, cleared on `endEditing`.

Service worker configuration lives at `src/web/projects/editor/ngsw-config.json`. Do not bypass it with `fetch` that sets `cache: 'no-store'` without a reason documented in the commit.

### Apple — mirror layers

1. **`NSCache`** for thumbnails in memory. App-scoped, auto-evicts on memory pressure.
2. **File-based disk cache** at `~/Library/Caches/app.justmaple.aperture/` for rendered previews, thumbnails, and remote source bytes. Pruned on a 30-day LRU sweep.
3. **Session state** in `@MainActor` `@Observable` types. Decoded f32 buffer lives in one slot per `EditSession`.

### Invalidation

Cache invalidation is the hard part. Every cache key above includes the fields that would change the output:

- Rendered preview keyed on `viewTransformVersion` — swap the view transform in v2 and every cached preview invalidates automatically.
- Rendered preview keyed on `adjustmentVersion` — any sidecar schema change ratchets the version.
- Thumbnail keyed on `(assetId, size)` — a new size variant is its own cache entry, not a collision.

If you add a new cache, document the key composition and the invalidation rule in `docs/caching.md`.

---

## API (server) best practices

### Repository pattern

Data access lives in `*.repo.ts` files. Routes call repo functions, never a database driver directly.

```typescript
// repositories/notebook.repo.ts
export async function findById(id: string): Promise<Notebook | null> {
  const doc = await collection().findOne({ _id: new ObjectId(id) });
  return doc ? mapNotebook(doc) : null;
}

export async function create(data: CreateNotebook): Promise<Notebook> {
  const now = new Date().toISOString();
  const result = await collection().insertOne({
    ...data,
    createdAt: now,
    updatedAt: now,
  });
  return {
    _id: result.insertedId.toString(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
}
```

### Route grouping with prefixes

```typescript
export const notebookRoutes = new Elysia({ prefix: '/api/notebooks' })
  .use(jwtPlugin)
  .derive(authDerivation)
  .get('/', listHandler)
  .post('/', createHandler, { body: createSchema })
  .get('/:id', getHandler)
  .put('/:id', updateHandler, { body: updateSchema })
  .delete('/:id', deleteHandler);
```

### Consistent error shape

```typescript
{ error: 'Unauthorized', message: 'Invalid or expired token' }
{ error: 'Not found', message: 'Notebook does not exist' }
{ error: 'Validation failed', message: 'Name is required' }
```

### Validation via TypeBox

```typescript
.post('/', handler, {
    body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        description: t.Optional(t.String({ maxLength: 500 })),
        color: t.Optional(t.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
    }),
})
```

---

## Swift / SwiftUI

### `@Observable` + `@MainActor` for UI state

```swift
@MainActor
@Observable
final class EditSession {
    private(set) var adjustments: AdjustmentModel
    private(set) var isRendering = false

    func updateExposure(_ value: Double) {
        adjustments.exposure = value
        scheduleRender()
    }
}
```

State the UI observes lives on `@MainActor`. Work that doesn't (decode, parse, thumbnail generation) runs on detached tasks or actors.

### Actors for I/O

```swift
actor XMPSidecarStore {
    func read(url: URL) async throws -> AdjustmentModel { ... }
    func write(_ model: AdjustmentModel, to url: URL) async throws { ... }
}

actor ThumbnailLoader {
    private var activeSlots: Int = 0
    private let maxSlots = 6
    // Concurrency-limited with checked continuations.
}
```

### Generation counters for async state

Folder switches and asset loads use a generation counter to reject stale writes.

```swift
@MainActor
func loadAssets(for folder: URL) async {
    loadGeneration &+= 1
    let gen = loadGeneration

    let urls = await filesystemSource.listImages(in: folder)
    guard gen == loadGeneration else { return }   // user switched folders

    for (index, url) in urls.enumerated() {
        let asset = await loadAsset(url)
        guard gen == loadGeneration else { return }
        assetSlots[index] = asset
    }
}
```

### Module boundary

All non-UI code in `MapleCore` SPM package. Platform `#if` guards are confined to views. No business logic in the app target.

### No template scaffold code

Delete Xcode's `ContentView`/`Item` placeholders when you replace them. Don't leave "example" code in the repo.

---

## Rust core

### Core is pure, platform bindings are thin

`raw-core` has no Apple or browser dependencies. It compiles to:

- An Apple xcframework via `raw-ffi` (cbindgen-generated C headers).
- A WASM bundle via `raw-wasm` (wasm-bindgen).

### Determinism is a hard requirement

Same input + same params → byte-identical output, across machines, across WASM/native. No wallclock reads, no random seeds (unless keyed on input content), no parallel reductions with non-associative operators. The baseline test catches non-determinism.

### `rayon` for CPU parallelism

Pipeline stages that decompose over pixels use `rayon`'s parallel iterators. Don't spawn threads manually.

### Tests at the stage level

Every pipeline stage has unit tests. The end-to-end ACR reference dataset test is the integration gate. Aim for ~1 unit test per public function and per failure mode, not per line of code.

### No `unwrap()` in library code

Library code returns `Result<T, E>`. `unwrap` and `expect` are for tests and binaries only.

---

## File naming

### kebab-case on web

```
user-profile.component.ts
auth.service.ts
notebook.repo.ts
page-type.guard.ts
```

### Suffixes

| Type        | Suffix                    |
| ----------- | ------------------------- |
| Component   | `.component.ts/html/scss` |
| Service     | `.service.ts`             |
| Repository  | `.repo.ts`                |
| Guard       | `.guard.ts`               |
| Interceptor | `.interceptor.ts`         |
| Resolver    | `.resolver.ts`            |
| Schema      | `.schema.ts`              |
| Model       | `.model.ts`               |
| Test        | `.spec.ts`                |

### Directory structure (Angular)

The codebase uses a flat, feature-grouped layout — no atoms/molecules/organisms hierarchy.

In `src/web/projects/maple-common/src/lib/`, each feature or component family gets its own folder at the top level of `lib/`. Reusable primitives (button, icons, collapsible) sit directly in named folders alongside feature groups (editor, info, library, search, shells). Larger feature groups that contain several related components use a single flat folder with no further nesting:

```
src/web/projects/maple-common/src/lib/
├── button/                 # MapleButtonComponent — reusable primitive
│   ├── maple-button.component.ts
│   ├── maple-button.component.html
│   └── maple-button.component.scss
├── collapsible/            # MapleCollapsibleComponent — reusable primitive
├── icons/                  # MaterialIconComponent, icon registry
├── components/             # Feature components shared across views
│   ├── asset-grid/
│   ├── filmstrip/
│   ├── image-canvas/
│   ├── editor-detail-panel/
│   └── ...                 # one folder per component, flat
├── editor/                 # Editor panel components (drag-bar, group-tabs, …)
├── info/                   # Info/metadata panel (histogram, keyword-chips, …)
├── library/                # Library grid and filter components
├── search/                 # Search bar, results sections
├── shells/                 # Layout shells (browse-shell, editor-shell, …)
│   ├── browse-shell/
│   ├── editor-shell/
│   └── source-picker-drawer/
└── ...                     # services, models, state, webgl, xmp, etc.
```

Within each folder, every component is exactly three files — `.ts`, `.html`, `.scss` — with no sub-folders. App-specific pages in `src/web/projects/maple/src/app/` follow the same pattern (one folder per route/feature, flat files inside).

The rule: one standalone component per folder, named after its folder. No barrel re-exports unless a folder is an intentional public-API boundary.

### PascalCase for Swift types, snake_case for Rust

Standard conventions for each language. No surprises.

---

## Git

### Commit format

```
type: short description

Longer description if needed.
```

### Commit types

| Type       | Description                           |
| ---------- | ------------------------------------- |
| `feat`     | New feature                           |
| `fix`      | Bug fix                               |
| `refactor` | Code restructure (no behavior change) |
| `perf`     | Performance improvement               |
| `docs`     | Documentation only                    |
| `test`     | Adding/updating tests                 |
| `chore`    | Build, deps, tooling                  |

### Branch naming

```
feat/panorama-stitcher
fix/webgl-gamut-mismatch
perf/tile-planner-cache
```

---

## Security

### Authentication

- JWTs in httpOnly cookies on web.
- Tokens in Keychain on Apple.
- Never log tokens, sidecar paths with PII, or user file contents.
- Implement silent token refresh; never prompt the user for a password on expiry if a refresh token is valid.

### Input validation

- Validate every inbound payload with TypeBox.
- Sanitize user-generated content before rendering.
- Use parameterized queries — no string-concatenated Mongo filters.

### CORS

- Allowlist known origins. No `*` in production.

### Secrets

- Environment variables in development, Key Vault (or equivalent) in production.
- No secrets in the repo. `.env` is gitignored. Pre-commit hook scans for likely credential patterns.

---

## Performance

### Angular

- `OnPush` change detection by default. Signals and observables flow cleanly through it.
- `track` on `@for` — by stable ID, not index.
- Lazy-load routes. Every page is its own bundle.
- Defer heavy work with `@defer` blocks where appropriate (histograms, scopes).

### API

- Indexes on every field used in a query filter. Confirm with `.explain()`.
- Pagination on every list endpoint. No unbounded returns.
- Projection to limit returned fields when the full document isn't needed.

### Swift

- `Task.detached` for CPU-heavy work.
- `AsyncStream` for event streams that cross actor boundaries.
- Avoid `@Published` in SwiftUI — `@Observable` is strictly better.

### Rust

- `rayon` for embarrassingly parallel work.
- Avoid allocation in hot loops. Reuse buffers.
- Profile with `samply` or `perf` before optimizing. Measure, don't guess.

### General

- Bundle size budget on web: editor entry chunk < 500KB gzipped. CI gates this.
- First contentful paint < 1.5s on a cold load.
- Slider tick: 16ms target on reference scenes.

---

## Don't ship these

| Anti-pattern                                          |
| ----------------------------------------------------- |
| `firstValueFrom` / `toPromise` in service layer       |
| `any` type                                            |
| `BehaviorSubject` inside a component (use signals)    |
| `@Input()` / `@Output()` decorator syntax             |
| Constructor DI in Angular                             |
| Inline templates or styles                            |
| Hardcoded hex colors                                  |
| Manual formatting                                     |
| `*ngIf` / `*ngFor` structural directives              |
| Combined page views with `@if (viewType === ...)`     |
| `import { Type, value }` — split type-only imports    |
| `console.log` in merged code                          |
| `fetch()` directly — use `HttpClient`                 |
| `localStorage` / `sessionStorage` for structured data |
| `unwrap()` in Rust library code                       |
| Platform `#if` in Swift business logic                |
| Raw DB driver calls in route handlers                 |
| Changes to color pipeline without running the harness |

## Ship these

| Practice                                          |
| ------------------------------------------------- |
| Standalone components, `OnPush`                   |
| Signals for local state, observables for async    |
| View models composing observables in components   |
| `input()`, `output()`, `inject()`                 |
| Separate `.ts` / `.html` / `.scss` files always   |
| Tailwind utilities + design tokens                |
| `@if` / `@for` control flow                       |
| `HttpClient` with observables                     |
| Service worker + IndexedDB on web                 |
| `NSCache` + file cache + session state on Apple   |
| Deterministic Rust core                           |
| Generation counters for async state               |
| Stage-level tests, end-to-end parity gates        |
| Cache keys that include every invalidating field  |
| Small focused components, services, and functions |

---

## Related documents

- `architecture.md` — system design, pipeline stages, module boundaries
- `caching.md` — cache layers, keys, invalidation rules
- `testing.md` — parity gates, ACR reference harness, metrics
- `sidecar-schema.md` — XMP format, namespaces, versioning
- `ui-spec.md` — layout, interaction, motion contract
