// asset-thumb.component.spec.ts — guards the filmstrip-only remnant's
// component-owned thumbnail signal and its accessible-name/selection
// behavior. The grid-specific tests that used to live here (no-preview
// badge, Select-mode checkbox, grid aria-pressed/aria-current) moved to
// asset-tile.component.spec.ts alongside the grid variant itself (MW6,
// #3047) — see this component's header comment for why the two no longer
// share one file.
//
// The key risk (flagged in #1364 review): subscribeThumbUrl pushes the current
// URL synchronously, and the component sets its `thumbUrl` signal from inside an
// effect. If that synchronous signal-write were disallowed it would throw NG0600
// the instant a tile mounts. These tests mount a REAL component with a stub that
// invokes the callback (the empty-stub mock used elsewhere would mask it).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { AssetThumbComponent } from './asset-thumb.component';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';

type ThumbCb = (url: string | undefined) => void;

function makeAsset(id: string, filename = 'a.jpg'): Asset {
  return { id: id as AssetId, filename } as Asset;
}

function configure(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AssetThumbComponent],
    providers: [
      {
        provide: LibraryStateService,
        useValue: {
          ensureThumbnailUrl: (a: Asset) => ensureCallsRef.push(a.id),
          cancelQueuedThumbnail: (id: AssetId) => cancelCallsRef.push(id),
          subscribeThumbUrl,
        },
      },
    ],
  });
}

// Module-scoped so `configure`'s closures (defined once, before any test's
// own arrays exist) always append to whatever array the CURRENT test reset
// in its own `beforeEach`.
let ensureCallsRef: AssetId[] = [];
let cancelCallsRef: AssetId[] = [];

describe('AssetThumbComponent — component-owned thumbnail signal', () => {
  let lastCb: ThumbCb | undefined;
  let unsubCount: number;

  beforeEach(() => {
    lastCb = undefined;
    unsubCount = 0;
    ensureCallsRef = [];
    cancelCallsRef = [];
  });

  function syncStub(initial: string | undefined = undefined) {
    return (_id: AssetId, cb: ThumbCb): (() => void) => {
      lastCb = cb;
      cb(initial); // synchronous push — runs inside the component's effect
      return () => unsubCount++;
    };
  }

  it('mounts without NG0600 when subscribeThumbUrl pushes synchronously', () => {
    configure(syncStub('blob:warm'));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges(); // flushes the effect → synchronous thumbUrl.set()

    expect(ensureCallsRef).toEqual(['lib:a.jpg']);
    expect(fixture.componentInstance.thumbUrl()).toBe('blob:warm');
  });

  it('updates thumbUrl on a later async push', () => {
    configure(syncStub(undefined));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(fixture.componentInstance.thumbUrl()).toBeUndefined();

    lastCb!('blob:loaded'); // cache pushes when the thumbnail lands
    expect(fixture.componentInstance.thumbUrl()).toBe('blob:loaded');
  });

  it('unsubscribes and re-subscribes when the asset input changes (recycle)', () => {
    configure(syncStub(undefined));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(unsubCount).toBe(0);

    fixture.componentRef.setInput('asset', makeAsset('lib:b.jpg'));
    fixture.detectChanges();
    // Old subscription cleaned up, new asset ensured.
    expect(unsubCount).toBe(1);
    expect(ensureCallsRef).toEqual(['lib:a.jpg', 'lib:b.jpg']);
  });

  it('unsubscribes on destroy (scroll-out)', () => {
    configure(syncStub(undefined));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    fixture.destroy();
    expect(unsubCount).toBe(1);
  });

  it('drops the queued thumbnail load on destroy (scroll-out)', () => {
    configure(syncStub(undefined));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    expect(cancelCallsRef).toEqual([]);

    fixture.destroy();
    expect(cancelCallsRef).toEqual(['lib:a.jpg']);
  });

  it('drops the previous asset queued load when a tile is recycled', () => {
    configure(syncStub(undefined));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();

    fixture.componentRef.setInput('asset', makeAsset('lib:b.jpg'));
    fixture.detectChanges();

    // Only the recycled-away asset is cancelled; the new one stays queued.
    expect(cancelCallsRef).toEqual(['lib:a.jpg']);
    expect(ensureCallsRef).toEqual(['lib:a.jpg', 'lib:b.jpg']);
  });
});

// #2414 — production audit MAPLE-PROD-10: 15/15 gallery + filmstrip <img>s
// had no accessible name and the accessible tree exposed no filenames.
// Pattern: the img stays decorative (alt="") and the clickable wrapper
// (a real <button>) carries the accessible name plus the focused state.
describe('AssetThumbComponent — accessible name and focus state (#2414)', () => {
  let thumbCb: ThumbCb | undefined;

  function configureWithSub(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AssetThumbComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: () => {},
            cancelQueuedThumbnail: () => {},
            subscribeThumbUrl,
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

  function render(filename: string, thumbUrl: string | undefined = undefined) {
    configureWithSub(syncStub(thumbUrl));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:x', filename));
    return fixture;
  }

  function wrapper(fixture: ReturnType<typeof render>): HTMLElement {
    const el = fixture.nativeElement.querySelector('[aria-label], .thumb') as HTMLElement | null;
    expect(el).not.toBeNull();
    return el!;
  }

  it('is labeled with the filename and the img is decorative', () => {
    const fixture = render('IMG_0042.dng', 'blob:loaded');
    fixture.detectChanges();

    const button = wrapper(fixture);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('IMG_0042.dng');

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.getAttribute('role')).toBe('presentation');
  });

  it('still exposes the accessible name before a thumbnail has loaded (no <img> yet)', () => {
    const fixture = render('IMG_0043.dng', undefined);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(wrapper(fixture).getAttribute('aria-label')).toBe('IMG_0043.dng');
  });

  it('marks the focused item as aria-current and keeps its name when an async thumbnail arrives', () => {
    const fixture = render('IMG_0044.dng');
    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();

    thumbCb!('blob:loaded');
    fixture.detectChanges();

    expect(wrapper(fixture).getAttribute('aria-label')).toBe('IMG_0044.dng');
    expect(wrapper(fixture).getAttribute('aria-current')).toBe('true');
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    expect(fixture.nativeElement.querySelector('img')?.getAttribute('role')).toBe('presentation');
  });

  it('exposes the focused state as both aria-current and aria-pressed', () => {
    const fixture = render('b.jpg');
    fixture.componentRef.setInput('focused', false);
    fixture.detectChanges();
    const el = wrapper(fixture);
    expect(el.getAttribute('aria-label')).toBe('b.jpg');
    expect(el.hasAttribute('aria-current')).toBe(false);
    expect(el.getAttribute('aria-pressed')).toBe('false');

    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();
    expect(wrapper(fixture).getAttribute('aria-current')).toBe('true');
    expect(wrapper(fixture).getAttribute('aria-pressed')).toBe('true');
  });

  it('keyboard focus: the focusable button contains the .thumb-ring overlay the :focus-visible SCSS rule lights', () => {
    // The visible focus indicator is `.thumb:focus-visible .thumb-ring`
    // (component SCSS — jsdom does not apply stylesheets, so assert the
    // structural precondition: the ring element the rule targets exists
    // inside the button that receives keyboard focus).
    const fixture = render('a.jpg');
    fixture.detectChanges();
    const button = wrapper(fixture);
    expect(button.classList.contains('thumb')).toBe(true);
    expect(button.querySelector('.thumb-ring')).not.toBeNull();
  });
});
