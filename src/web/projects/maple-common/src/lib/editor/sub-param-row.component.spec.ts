// sub-param-row.component.spec.ts — multi-param tool pills (#1108).
//
// DOM contract for the chip row: hidden for single-param tools, one
// chip per sub-param with stable testids, click arms the (tool,
// subParam) pair, armed styling via aria-pressed, modified dot when the
// field is off its canonical default.
//
// #3046: chrome now delegates to `mui-chip-row` — the modified-dot class
// is that shared atom's own `.modified-dot` (also used by the crop
// toolbar's aspect chips), not the retired local `.dot`.

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { SubParamRowComponent } from './sub-param-row.component';
import { EditorStateService } from './editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();

  ensure(id: string): void {
    if (!this.models.has(id)) {
      this.models.set(id, signal(defaultAdjustmentModel()));
    }
  }

  adjustmentFor(id: string): Signal<AdjustmentModel> {
    this.ensure(id);
    return this.models.get(id)!.asReadonly();
  }

  updateAdjustment(id: string, patch: Partial<AdjustmentModel>): void {
    this.ensure(id);
    this.models.get(id)!.update((m) => ({ ...m, ...patch }));
  }
}

describe('SubParamRowComponent (#1108)', () => {
  let svc: EditorStateService;
  let lib: LibraryStub;

  const ID = 'asset-1';

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
    });
    svc = TestBed.inject(EditorStateService);
    svc.bind(ID);
  });

  function render() {
    const fixture = TestBed.createComponent(SubParamRowComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing while a single-param tool is armed', () => {
    svc.armTool('exposure');
    const fixture = render();
    expect(fixture.nativeElement.querySelector('[data-testid="editor-subparam-row"]')).toBeNull();
  });

  it('renders one chip per sub-param with stable testids', () => {
    svc.armTool('sharpen');
    const fixture = render();
    const chips = [
      ...fixture.nativeElement.querySelectorAll('[data-testid^="editor-subparam-"]'),
    ].map((el) => (el as HTMLElement).dataset['testid']);
    expect(chips).toEqual([
      'editor-subparam-row',
      'editor-subparam-amount',
      'editor-subparam-radius',
      'editor-subparam-detail',
      'editor-subparam-masking',
    ]);
  });

  it('marks the armed chip with aria-pressed and arms on click', () => {
    svc.armTool('noise');
    const fixture = render();
    const chip = (sel: string) =>
      fixture.nativeElement.querySelector(`[data-testid="editor-subparam-${sel}"]`) as HTMLElement;
    expect(chip('luminance').getAttribute('aria-pressed')).toBe('true');
    expect(chip('color').getAttribute('aria-pressed')).toBe('false');

    chip('color').click();
    fixture.detectChanges();
    expect(svc.armedSubParamId()).toBe('color');
    expect(chip('color').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the modified dot only when the sub-param is off its default', () => {
    svc.armTool('noise');
    const fixture = render();
    const dotIn = (sel: string) =>
      fixture.nativeElement.querySelector(`[data-testid="editor-subparam-${sel}"] .modified-dot`);
    expect(dotIn('luminance')).toBeNull();
    expect(dotIn('color')).toBeNull();

    lib.updateAdjustment(ID, { nrColor: 60 });
    fixture.detectChanges();
    expect(dotIn('color')).not.toBeNull();
    expect(dotIn('luminance')).toBeNull();
  });
});
