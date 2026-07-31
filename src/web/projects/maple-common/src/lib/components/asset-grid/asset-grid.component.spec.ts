// asset-grid.component.spec.ts — grid click semantics (#2404).
//
// Apple's BrowseGrid goes straight to Preview on a single tap; Web used to
// require a double-click. This spec guards the replacement contract: a
// plain click selects AND navigates to `/view/…`, Cmd/Ctrl-click and
// Shift-click each mutate the selection without navigating, and while
// Select mode is on every click toggles membership and never navigates.
//
// Exercises `onThumbClick` directly against a constructed component
// instance (same pattern as editor-shell.component.spec.ts's route-
// resolution tests) rather than rendering the cdk-virtual-scroll template —
// the click handler's branching is pure logic over its injected collaborators
// and doesn't need a DOM render to prove out.

import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AssetGridComponent } from './asset-grid.component';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';

function makeAsset(id: string): Asset {
  return { id: id as AssetId, filename: `${id}.jpg` } as Asset;
}

function click(opts: Partial<Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>> = {}) {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...opts,
  } as MouseEvent;
}

describe('AssetGridComponent — click semantics (#2404)', () => {
  let selectAsset: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let isSelecting: boolean;
  let component: AssetGridComponent;

  const asset = makeAsset('a1.jpg');

  beforeEach(() => {
    selectAsset = vi.fn();
    navigate = vi.fn();
    isSelecting = false;

    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            isSelecting: () => isSelecting,
            selectAsset,
          },
        },
        { provide: Router, useValue: { navigate } },
      ],
    });

    component = TestBed.runInInjectionContext(() => new AssetGridComponent());
  });

  it('a plain click selects and navigates to /view/…', () => {
    component.onThumbClick(asset, click());

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', false, false);
    expect(navigate).toHaveBeenCalledTimes(1);
    // fs:/no-colon ids pass through as a single segment (route-address.ts).
    expect(navigate).toHaveBeenCalledWith(['/view', 'a1.jpg']);
  });

  it('Cmd-click toggles selection and does not navigate', () => {
    component.onThumbClick(asset, click({ metaKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Ctrl-click toggles selection and does not navigate', () => {
    component.onThumbClick(asset, click({ ctrlKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Shift-click extends the range and does not navigate', () => {
    component.onThumbClick(asset, click({ shiftKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', false, true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a click in Select mode toggles membership and does not navigate', () => {
    isSelecting = true;
    component.onThumbClick(asset, click());

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a modifier click in Select mode still just toggles — no range, no navigate', () => {
    isSelecting = true;
    component.onThumbClick(asset, click({ shiftKey: true, metaKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
