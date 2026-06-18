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

function makeAsset(id: string): Asset {
  return { id: id as AssetId, filename: 'a.jpg' } as Asset;
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
