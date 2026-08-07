// asset-thumb.component.spec.ts — guards the component-owned thumbnail signal.
//
// The key risk (flagged in #1364 review): subscribeThumbUrl pushes the current
// URL synchronously, and the component sets its `thumbUrl` signal from inside an
// effect. If that synchronous signal-write were disallowed it would throw NG0600
// the instant a tile mounts. These tests mount a REAL component with a stub that
// invokes the callback (the empty-stub mock used elsewhere would mask it).
//
// Every `render()` / inline `TestBed.createComponent(AssetThumbComponent)` call
// is preceded by `await TestBed.compileComponents()` and every enclosing `it()`
// is `async` (#2706 web-build bundle-size fix): the component's template now has
// an `@defer (on interaction(renameTrigger))` block, and Angular's JIT compiler
// (used in tests; the production build is AOT and unaffected) resolves a
// deferred block's dependencies asynchronously even when
// `deferBlockBehavior: DeferBlockBehavior.Manual` keeps it from actually
// triggering at runtime — that Manual setting (still set below) only stops the
// dynamic import from firing on interaction during a test, not the one-time
// async metadata resolution `compileComponents()` performs.

import { TestBed, DeferBlockBehavior } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { AssetThumbComponent } from './asset-thumb.component';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';

type ThumbCb = (url: string | undefined) => void;

function makeAsset(id: string, filename = 'a.jpg'): Asset {
  return { id: id as AssetId, filename } as Asset;
}

describe('AssetThumbComponent — component-owned thumbnail signal', () => {
  let lastCb: ThumbCb | undefined;
  let unsubCount: number;
  let ensureCalls: AssetId[];
  let cancelCalls: AssetId[];

  function configure(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // `imports` (not just `providers`) is required so TestBed queues
      // AssetThumbComponent's async defer-block metadata BEFORE
      // `compileComponents()` runs below — without this, TestBed doesn't
      // learn about the component until `createComponent()`, which is too
      // late for `compileComponents()` to have resolved anything.
      imports: [AssetThumbComponent],
      deferBlockBehavior: DeferBlockBehavior.Manual,
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: (a: Asset) => ensureCalls.push(a.id),
            cancelQueuedThumbnail: (id: AssetId) => cancelCalls.push(id),
            subscribeThumbUrl,
            isSelecting: () => false,
          },
        },
      ],
    });
  }

  beforeEach(() => {
    lastCb = undefined;
    unsubCount = 0;
    ensureCalls = [];
    cancelCalls = [];
  });

  // A stub that mirrors the real cache: it invokes `cb` SYNCHRONOUSLY with the
  // current value (here `undefined`), then keeps the ref for later async pushes.
  function syncStub(initial: string | undefined = undefined) {
    return (_id: AssetId, cb: ThumbCb): (() => void) => {
      lastCb = cb;
      cb(initial); // synchronous push — runs inside the component's effect
      return () => unsubCount++;
    };
  }

  it('mounts without NG0600 when subscribeThumbUrl pushes synchronously', async () => {
    configure(syncStub('blob:warm'));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges(); // flushes the effect → synchronous thumbUrl.set()

    expect(ensureCalls).toEqual(['lib:a.jpg']);
    expect(fixture.componentInstance.thumbUrl()).toBe('blob:warm');
  });

  it('updates thumbUrl on a later async push', async () => {
    configure(syncStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(fixture.componentInstance.thumbUrl()).toBeUndefined();

    lastCb!('blob:loaded'); // cache pushes when the thumbnail lands
    expect(fixture.componentInstance.thumbUrl()).toBe('blob:loaded');
  });

  it('unsubscribes and re-subscribes when the asset input changes (recycle)', async () => {
    configure(syncStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(unsubCount).toBe(0);

    fixture.componentRef.setInput('asset', makeAsset('lib:b.jpg'));
    fixture.detectChanges();
    // Old subscription cleaned up, new asset ensured.
    expect(unsubCount).toBe(1);
    expect(ensureCalls).toEqual(['lib:a.jpg', 'lib:b.jpg']);
  });

  it('unsubscribes on destroy (scroll-out)', async () => {
    configure(syncStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    fixture.destroy();
    expect(unsubCount).toBe(1);
  });

  // The browse grid virtualizes, so scrolling destroys tiles continuously. A
  // destroyed tile's queued thumbnail request must be dropped, or the rows
  // actually on screen wait behind requests for rows already scrolled past.
  it('drops the queued thumbnail load on destroy (scroll-out)', async () => {
    configure(syncStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(cancelCalls).toEqual([]);

    fixture.destroy();
    expect(cancelCalls).toEqual(['lib:a.jpg']);
  });

  it('drops the previous asset queued load when a tile is recycled', async () => {
    configure(syncStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();

    fixture.componentRef.setInput('asset', makeAsset('lib:b.jpg'));
    fixture.detectChanges();

    // Only the recycled-away asset is cancelled; the new one stays queued.
    expect(cancelCalls).toEqual(['lib:a.jpg']);
    expect(ensureCalls).toEqual(['lib:a.jpg', 'lib:b.jpg']);
  });
});

describe('AssetThumbComponent — no-preview badge', () => {
  function configure(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // `imports` (not just `providers`) is required so TestBed queues
      // AssetThumbComponent's async defer-block metadata BEFORE
      // `compileComponents()` runs below — without this, TestBed doesn't
      // learn about the component until `createComponent()`, which is too
      // late for `compileComponents()` to have resolved anything.
      imports: [AssetThumbComponent],
      deferBlockBehavior: DeferBlockBehavior.Manual,
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: () => {},
            cancelQueuedThumbnail: () => {},
            subscribeThumbUrl,
            isSelecting: () => false,
          },
        },
      ],
    });
  }

  function syncStub(initial: string | undefined = undefined) {
    return (_id: AssetId, cb: ThumbCb): (() => void) => {
      cb(initial);
      return () => {};
    };
  }

  async function render(filename: string, thumbUrl: string | undefined = undefined) {
    configure(syncStub(thumbUrl));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:x', filename));
    fixture.detectChanges();
    return fixture;
  }

  it('renders the uppercased extension badge for a stub image with no thumbnail', async () => {
    const fixture = await render('scan.eip');
    expect(fixture.nativeElement.textContent).toContain('EIP');
  });

  it('renders the badge for an audio file with no thumbnail', async () => {
    const fixture = await render('track.mp3');
    expect(fixture.nativeElement.textContent).toContain('MP3');
  });

  it('renders the badge for a video file with no thumbnail', async () => {
    const fixture = await render('clip.mov');
    expect(fixture.nativeElement.textContent).toContain('MOV');
  });

  it('does not render a badge for a normal photo with no thumbnail yet', async () => {
    const fixture = await render('IMG_0001.jpg');
    expect(fixture.nativeElement.textContent).not.toContain('JPG');
  });

  it('does not render a badge for a RAW file with no thumbnail yet', async () => {
    const fixture = await render('IMG_0001.dng');
    expect(fixture.nativeElement.textContent).not.toContain('DNG');
  });

  it('does not render the badge once a thumbnail resolves, even for a stub extension', async () => {
    const fixture = await render('scan.eip', 'blob:loaded');
    expect(fixture.nativeElement.textContent).not.toContain('EIP');
  });
});

describe('AssetThumbComponent — Select-mode checkbox (#2404)', () => {
  function configure(selecting: boolean) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // `imports` (not just `providers`) is required so TestBed queues
      // AssetThumbComponent's async defer-block metadata BEFORE
      // `compileComponents()` runs below — without this, TestBed doesn't
      // learn about the component until `createComponent()`, which is too
      // late for `compileComponents()` to have resolved anything.
      imports: [AssetThumbComponent],
      deferBlockBehavior: DeferBlockBehavior.Manual,
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: () => {},
            cancelQueuedThumbnail: () => {},
            subscribeThumbUrl: (_id: AssetId, cb: ThumbCb) => {
              cb(undefined);
              return () => {};
            },
            isSelecting: () => selecting,
          },
        },
      ],
    });
  }

  async function render(opts: { selecting: boolean; selected?: boolean; edited?: boolean }) {
    configure(opts.selecting);
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', {
      ...makeAsset('lib:a.jpg'),
      edited: opts.edited ?? false,
    });
    fixture.componentRef.setInput('selected', opts.selected ?? false);
    fixture.componentRef.setInput('variant', 'grid');
    fixture.detectChanges();
    return fixture;
  }

  it('renders no checkbox affordance when Select mode is off', async () => {
    const fixture = await render({ selecting: false, selected: true });
    expect(fixture.nativeElement.querySelector('[data-testid="select-checkbox"]')).toBeNull();
  });

  it('renders an unchecked affordance in Select mode when not selected', async () => {
    const fixture = await render({ selecting: true, selected: false });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('bg-primary')).toBe(false);
    expect(badge!.querySelector('svg')).toBeNull();
  });

  it('renders a checked affordance in Select mode when selected', async () => {
    const fixture = await render({ selecting: true, selected: true });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('bg-primary')).toBe(true);
    expect(badge!.querySelector('svg')).not.toBeNull();
  });

  it('shifts the checkbox left of the edited badge when both render', async () => {
    const fixture = await render({ selecting: true, selected: true, edited: true });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge!.classList.contains('right-[22px]')).toBe(true);
    // The edited badge keeps its usual spot.
    const editedBadge = fixture.nativeElement.querySelector('.border-success-text');
    expect(editedBadge).not.toBeNull();
    expect(editedBadge!.classList.contains('right-[5px]')).toBe(true);
  });

  it('does not render the checkbox for the filmstrip variant even in Select mode', async () => {
    configure(true);
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.componentRef.setInput('selected', true);
    fixture.componentRef.setInput('variant', 'filmstrip');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="select-checkbox"]')).toBeNull();
  });
});

// #2414 — production audit MAPLE-PROD-10: 15/15 gallery + filmstrip <img>s
// had no accessible name and the accessible tree exposed no filenames.
// Pattern: the img stays decorative (alt="") and the clickable wrapper
// (a real <button>, matching the LibraryCell / timeline-photo / search-tile
// precedent elsewhere in this codebase) carries the accessible name plus
// the variant-appropriate selection state.
describe('AssetThumbComponent — accessible name and selection state (#2414)', () => {
  let thumbCb: ThumbCb | undefined;

  function configure(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // `imports` (not just `providers`) is required so TestBed queues
      // AssetThumbComponent's async defer-block metadata BEFORE
      // `compileComponents()` runs below — without this, TestBed doesn't
      // learn about the component until `createComponent()`, which is too
      // late for `compileComponents()` to have resolved anything.
      imports: [AssetThumbComponent],
      deferBlockBehavior: DeferBlockBehavior.Manual,
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: () => {},
            cancelQueuedThumbnail: () => {},
            subscribeThumbUrl,
            isSelecting: () => false,
          },
        },
      ],
    });
  }

  function syncStub(initial: string | undefined = undefined) {
    return (_id: AssetId, cb: ThumbCb): (() => void) => {
      thumbCb = cb;
      cb(initial);
      return () => {};
    };
  }

  async function render(filename: string, thumbUrl: string | undefined = undefined) {
    configure(syncStub(thumbUrl));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:x', filename));
    return fixture;
  }

  function wrapper(fixture: Awaited<ReturnType<typeof render>>): HTMLElement {
    const el = fixture.nativeElement.querySelector('[aria-label], .thumb') as HTMLElement | null;
    expect(el).not.toBeNull();
    return el!;
  }

  it('grid tile: the button wrapper is labeled with the filename and the img is decorative', async () => {
    const fixture = await render('IMG_0042.dng', 'blob:loaded');
    fixture.detectChanges();

    const button = wrapper(fixture);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('IMG_0042.dng');

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.getAttribute('role')).toBe('presentation');
  });

  it('grid tile: still exposes the accessible name before a thumbnail has loaded (no <img> yet)', async () => {
    const fixture = await render('IMG_0043.dng', undefined);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(wrapper(fixture).getAttribute('aria-label')).toBe('IMG_0043.dng');
  });

  it('keeps its name and selection state when an async thumbnail arrives', async () => {
    const fixture = await render('IMG_0044.dng');
    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();

    thumbCb!('blob:loaded');
    fixture.detectChanges();

    expect(wrapper(fixture).getAttribute('aria-label')).toBe('IMG_0044.dng');
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('true');
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('role')).toBe('presentation');
  });

  it('grid tile: reflects the multi-select state via aria-pressed', async () => {
    const fixture = await render('a.jpg');
    fixture.componentRef.setInput('variant', 'grid');
    fixture.componentRef.setInput('selected', false);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('false');

    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('true');
  });

  it('grid tile: never reports aria-current — that state belongs to the filmstrip', async () => {
    const fixture = await render('a.jpg');
    fixture.componentRef.setInput('variant', 'grid');
    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(wrapper(fixture).hasAttribute('aria-current')).toBe(false);
  });

  it('filmstrip item: is labeled with the filename and marks the focused item as aria-current', async () => {
    const fixture = await render('b.jpg');
    fixture.componentRef.setInput('variant', 'filmstrip');
    fixture.componentRef.setInput('focused', false);
    fixture.detectChanges();
    const el = wrapper(fixture);
    expect(el.getAttribute('aria-label')).toBe('b.jpg');
    expect(el.hasAttribute('aria-current')).toBe(false);

    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-current')).toBe('true');
  });

  it('filmstrip item: exposes its focused state as pressed for browser accessibility trees', async () => {
    const fixture = await render('b.jpg');
    fixture.componentRef.setInput('variant', 'filmstrip');
    fixture.componentRef.setInput('focused', false);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('false');

    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('true');
  });

  it('keyboard focus: the focusable button contains the .thumb-ring overlay the :focus-visible SCSS rule lights', async () => {
    // The visible focus indicator is `.thumb:focus-visible .thumb-ring`
    // (component SCSS — jsdom does not apply stylesheets, so assert the
    // structural precondition: the ring element the rule targets exists
    // inside the button that receives keyboard focus).
    const fixture = await render('a.jpg');
    fixture.detectChanges();
    const button = wrapper(fixture);
    expect(button.classList.contains('thumb')).toBe(true);
    expect(button.querySelector('.thumb-ring')).not.toBeNull();
  });
});
