// asset-thumb.component.spec.ts — guards the component-owned thumbnail signal.
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

describe('AssetThumbComponent — component-owned thumbnail signal', () => {
  let lastCb: ThumbCb | undefined;
  let unsubCount: number;
  let ensureCalls: AssetId[];

  function configure(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: (a: Asset) => ensureCalls.push(a.id),
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

  it('mounts without NG0600 when subscribeThumbUrl pushes synchronously', () => {
    configure(syncStub('blob:warm'));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges(); // flushes the effect → synchronous thumbUrl.set()

    expect(ensureCalls).toEqual(['lib:a.jpg']);
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
    expect(ensureCalls).toEqual(['lib:a.jpg', 'lib:b.jpg']);
  });

  it('unsubscribes on destroy (scroll-out)', () => {
    configure(syncStub(undefined));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.detectChanges();
    fixture.destroy();
    expect(unsubCount).toBe(1);
  });
});

describe('AssetThumbComponent — no-preview badge', () => {
  function configure(subscribeThumbUrl: (id: AssetId, cb: ThumbCb) => () => void) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: () => {},
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

  function render(filename: string, thumbUrl: string | undefined = undefined) {
    configure(syncStub(thumbUrl));
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:x', filename));
    fixture.detectChanges();
    return fixture;
  }

  it('renders the uppercased extension badge for a stub image with no thumbnail', () => {
    const fixture = render('scan.eip');
    expect(fixture.nativeElement.textContent).toContain('EIP');
  });

  it('renders the badge for an audio file with no thumbnail', () => {
    const fixture = render('track.mp3');
    expect(fixture.nativeElement.textContent).toContain('MP3');
  });

  it('renders the badge for a video file with no thumbnail', () => {
    const fixture = render('clip.mov');
    expect(fixture.nativeElement.textContent).toContain('MOV');
  });

  it('does not render a badge for a normal photo with no thumbnail yet', () => {
    const fixture = render('IMG_0001.jpg');
    expect(fixture.nativeElement.textContent).not.toContain('JPG');
  });

  it('does not render a badge for a RAW file with no thumbnail yet', () => {
    const fixture = render('IMG_0001.dng');
    expect(fixture.nativeElement.textContent).not.toContain('DNG');
  });

  it('does not render the badge once a thumbnail resolves, even for a stub extension', () => {
    const fixture = render('scan.eip', 'blob:loaded');
    expect(fixture.nativeElement.textContent).not.toContain('EIP');
  });
});

describe('AssetThumbComponent — Select-mode checkbox (#2404)', () => {
  function configure(selecting: boolean) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            ensureThumbnailUrl: () => {},
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

  function render(opts: { selecting: boolean; selected?: boolean; edited?: boolean }) {
    configure(opts.selecting);
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

  it('renders no checkbox affordance when Select mode is off', () => {
    const fixture = render({ selecting: false, selected: true });
    expect(fixture.nativeElement.querySelector('[data-testid="select-checkbox"]')).toBeNull();
  });

  it('renders an unchecked affordance in Select mode when not selected', () => {
    const fixture = render({ selecting: true, selected: false });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('bg-primary')).toBe(false);
    expect(badge!.querySelector('svg')).toBeNull();
  });

  it('renders a checked affordance in Select mode when selected', () => {
    const fixture = render({ selecting: true, selected: true });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('bg-primary')).toBe(true);
    expect(badge!.querySelector('svg')).not.toBeNull();
  });

  it('shifts the checkbox left of the edited badge when both render', () => {
    const fixture = render({ selecting: true, selected: true, edited: true });
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge!.classList.contains('right-[22px]')).toBe(true);
    // The edited badge keeps its usual spot.
    const editedBadge = fixture.nativeElement.querySelector('.border-success-text');
    expect(editedBadge).not.toBeNull();
    expect(editedBadge!.classList.contains('right-[5px]')).toBe(true);
  });

  it('does not render the checkbox for the filmstrip variant even in Select mode', () => {
    configure(true);
    const fixture = TestBed.createComponent(AssetThumbComponent);
    fixture.componentRef.setInput('asset', makeAsset('lib:a.jpg'));
    fixture.componentRef.setInput('selected', true);
    fixture.componentRef.setInput('variant', 'filmstrip');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="select-checkbox"]')).toBeNull();
  });
});
