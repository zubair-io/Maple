// asset-tile.component.spec.ts — grid-cell tile split out of asset-thumb's
// original `variant="grid"` branch (MW6, #3047). Behavior assertions are
// carried over from `asset-thumb.component.spec.ts`'s grid-focused
// describe blocks; selectors are updated where the tile's internal DOM
// legitimately changed (composed from `<mui-media-cell layout="overlay">`
// instead of a hand-rolled `<button class="thumb">`).
//
// The key risk (flagged in #1364 review, carried over unchanged): the
// thumbnail-loading effect writes `thumbUrl` synchronously from inside an
// effect the moment `subscribeThumbUrl` pushes a value — these tests mount
// a REAL component with a stub that invokes the callback synchronously
// (the empty-stub mock used elsewhere would mask an NG0600 regression).
//
// Every `render()` call awaits `TestBed.compileComponents()` first, and
// every enclosing `it()` is `async` (#2706 web-build bundle-size fix): the
// template has an `@defer (on interaction(renameTrigger))` block, and
// Angular's JIT compiler (used in tests) resolves a deferred block's
// dependencies asynchronously even with `deferBlockBehavior: Manual`.

import { TestBed, DeferBlockBehavior } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { AssetTileComponent } from './asset-tile.component';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';

type ThumbCb = (url: string | undefined) => void;

function makeAsset(id: string, filename = 'a.jpg'): Asset {
  return { id: id as AssetId, filename, thumbnailGradient: 'data:image/svg+xml,x' } as Asset;
}

function configure(
  subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void,
  overrides: {
    ensureThumbnailUrl?: (a: Asset) => void;
    cancelQueuedThumbnail?: (id: AssetId) => void;
    isSelecting?: () => boolean;
  } = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    // `imports` (not just `providers`) is required so TestBed queues
    // AssetTileComponent's async defer-block metadata BEFORE
    // `compileComponents()` runs below.
    imports: [AssetTileComponent],
    deferBlockBehavior: DeferBlockBehavior.Manual,
    providers: [
      {
        provide: LibraryStateService,
        useValue: {
          ensureThumbnailUrl: overrides.ensureThumbnailUrl ?? (() => {}),
          cancelQueuedThumbnail: overrides.cancelQueuedThumbnail ?? (() => {}),
          subscribeThumbUrl,
          isSelecting: overrides.isSelecting ?? (() => false),
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

describe('AssetTileComponent — component-owned thumbnail signal', () => {
  let lastCb: ThumbCb | undefined;
  let unsubCount: number;
  let ensureCalls: AssetId[];
  let cancelCalls: AssetId[];

  beforeEach(() => {
    lastCb = undefined;
    unsubCount = 0;
    ensureCalls = [];
    cancelCalls = [];
  });

  function trackingStub(initial: string | undefined = undefined) {
    return (_id: AssetId, cb: ThumbCb): (() => void) => {
      lastCb = cb;
      cb(initial);
      return () => unsubCount++;
    };
  }

  it('mounts without NG0600 when subscribeThumbUrl pushes synchronously', async () => {
    configure(trackingStub('blob:warm'), { ensureThumbnailUrl: (a) => ensureCalls.push(a.id) });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges(); // flushes the effect → synchronous thumbUrl.set()

    expect(ensureCalls).toEqual(['lib:a.jpg']);
    expect(fixture.componentInstance.thumbUrl()).toBe('blob:warm');
  });

  it('updates thumbUrl on a later async push', async () => {
    configure(trackingStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(fixture.componentInstance.thumbUrl()).toBeUndefined();

    lastCb!('blob:loaded');
    expect(fixture.componentInstance.thumbUrl()).toBe('blob:loaded');
  });

  it('unsubscribes and re-subscribes when the asset input changes (recycle)', async () => {
    configure(trackingStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(unsubCount).toBe(0);

    fixture.componentRef.setInput('asset', makeAsset('lib:b.jpg'));
    fixture.detectChanges();
    expect(unsubCount).toBe(1);
    expect(ensureCalls).toEqual([]);
  });

  it('unsubscribes on destroy (scroll-out)', async () => {
    configure(trackingStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    fixture.destroy();
    expect(unsubCount).toBe(1);
  });

  it('drops the queued thumbnail load on destroy (scroll-out)', async () => {
    configure(trackingStub(undefined), { cancelQueuedThumbnail: (id) => cancelCalls.push(id) });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(cancelCalls).toEqual([]);

    fixture.destroy();
    expect(cancelCalls).toEqual(['lib:a.jpg']);
  });

  it('drops the previous asset queued load when a tile is recycled', async () => {
    configure(trackingStub(undefined), { cancelQueuedThumbnail: (id) => cancelCalls.push(id) });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();

    fixture.componentRef.setInput('asset', makeAsset('lib:b.jpg'));
    fixture.detectChanges();

    expect(cancelCalls).toEqual(['lib:a.jpg']);
  });
});

describe('AssetTileComponent — no-preview badge', () => {
  async function render(filename: string, thumbUrl: string | undefined = undefined) {
    configure(syncStub(thumbUrl));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
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

describe('AssetTileComponent — Select-mode checkbox (#2404)', () => {
  async function render(opts: { selecting: boolean; selected?: boolean; edited?: boolean }) {
    configure(
      (_id, cb) => {
        cb(undefined);
        return () => {};
      },
      { isSelecting: () => opts.selecting },
    );
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', {
      ...makeAsset('lib:a.jpg'),
      edited: opts.edited ?? false,
    });
    fixture.componentRef.setInput('selected', opts.selected ?? false);
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

  // The exact `right-[22px]` shift class asset-thumb used to compute is
  // gone — mui-media-cell's `mediaCellTopRight` overlay slot now stacks
  // its projected children with a flex `gap` instead, so this asserts the
  // surviving behavior (both render, side by side) rather than the
  // retired implementation detail.
  it('renders both the checkbox and the edited badge, side by side, when both apply', async () => {
    const fixture = await render({ selecting: true, selected: true, edited: true });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    const editedBadge = fixture.nativeElement.querySelector('.border-success-text');
    expect(badge).not.toBeNull();
    expect(editedBadge).not.toBeNull();
    // Both live in the same top-right overlay slot.
    const slot = fixture.nativeElement.querySelector('.overlay-slot.top-right');
    expect(slot.contains(badge)).toBe(true);
    expect(slot.contains(editedBadge)).toBe(true);
  });
});

// #2414 — production audit MAPLE-PROD-10: 15/15 gallery + filmstrip <img>s
// had no accessible name and the accessible tree exposed no filenames.
// Pattern carried over: the img stays decorative (alt="") and the
// clickable wrapper (now `mui-media-cell`'s overlay `<button>`) carries the
// accessible name plus the selection state.
describe('AssetTileComponent — accessible name and selection state (#2414)', () => {
  let thumbCb: ThumbCb | undefined;

  async function render(filename: string, thumbUrl: string | undefined = undefined) {
    configure((_id, cb) => {
      thumbCb = cb;
      cb(thumbUrl);
      return () => {};
    });
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:x', filename));
    return fixture;
  }

  function wrapper(fixture: Awaited<ReturnType<typeof render>>): HTMLElement {
    const el = fixture.nativeElement.querySelector('.mui-media-cell.overlay') as HTMLElement | null;
    expect(el).not.toBeNull();
    return el!;
  }

  it('the button wrapper is labeled with the filename and the img is decorative', async () => {
    const fixture = await render('IMG_0042.dng', 'blob:loaded');
    fixture.detectChanges();

    const button = wrapper(fixture);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('IMG_0042.dng');

    // The img stays decorative (empty alt) — the accessible name lives on
    // the wrapping button's aria-label, matching the original pattern.
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('');
  });

  it('still exposes the accessible name before a thumbnail has loaded (gradient placeholder, no <img>)', async () => {
    const fixture = await render('IMG_0043.dng', undefined);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.querySelector('.gradient-placeholder')).not.toBeNull();
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
  });

  it('reflects the multi-select state via aria-pressed', async () => {
    const fixture = await render('a.jpg');
    fixture.componentRef.setInput('selected', false);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('false');

    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('true');
  });

  it('the interactive root contains the .thumb-ring overlay the selection/focus-visible CSS lights', async () => {
    const fixture = await render('a.jpg');
    fixture.detectChanges();
    const button = wrapper(fixture);
    expect(button.querySelector('.thumb-ring')).not.toBeNull();
  });

  it('the rename trigger button is NOT a descendant of the interactive overlay button (nested-interactive safety)', async () => {
    const fixture = await render('a.jpg');
    fixture.detectChanges();
    const button = wrapper(fixture);
    const renameTrigger = fixture.nativeElement.querySelector(
      '.filename-bar:not(.editing)',
    ) as HTMLElement;
    expect(renameTrigger).not.toBeNull();
    expect(button.contains(renameTrigger)).toBe(false);
  });

  it('thumbClick emits the underlying MouseEvent (for modifier-key multi-select)', async () => {
    const fixture = await render('a.jpg', 'blob:loaded');
    fixture.detectChanges();
    let received: MouseEvent | undefined;
    fixture.componentInstance.thumbClick.subscribe((e) => (received = e));
    wrapper(fixture).click();
    expect(received).toBeInstanceOf(MouseEvent);
  });
});

describe('AssetTileComponent — hidden dimming and badge', () => {
  async function render(hidden: boolean) {
    configure(syncStub(undefined));
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(AssetTileComponent);
    fixture.componentRef.setInput('asset', { ...makeAsset('lib:a.jpg'), hidden });
    fixture.detectChanges();
    return fixture;
  }

  it('renders the HIDDEN badge and dims the cell when the asset is hidden', async () => {
    const fixture = await render(true);
    expect(fixture.nativeElement.textContent).toContain('HIDDEN');
    expect(fixture.nativeElement.querySelector('.overlay.is-dimmed')).not.toBeNull();
  });

  it('renders neither for a visible asset', async () => {
    const fixture = await render(false);
    expect(fixture.nativeElement.textContent).not.toContain('HIDDEN');
    expect(fixture.nativeElement.querySelector('.overlay.is-dimmed')).toBeNull();
  });
});
