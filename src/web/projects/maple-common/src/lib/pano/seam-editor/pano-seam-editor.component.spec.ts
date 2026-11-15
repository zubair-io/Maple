import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanoSeamEditorComponent } from './pano-seam-editor.component';

const frames = [
  { assetId: 'z-id', path: '/photos/a.dng' },
  { assetId: 'a-id', path: '/photos/z.dng' },
];

describe('panorama seam editor', () => {
  let fixture: ComponentFixture<PanoSeamEditorComponent>;
  let editor: PanoSeamEditorComponent;
  let root: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PanoSeamEditorComponent] });
    fixture = TestBed.createComponent(PanoSeamEditorComponent);
    fixture.componentRef.setInput('imageUrl', 'blob:preview');
    fixture.componentRef.setInput('previewCanvas', { width: 1000, height: 400 });
    fixture.componentRef.setInput('frames', frames);
    fixture.detectChanges();
    editor = fixture.componentInstance;
    root = fixture.nativeElement;
  });

  function numeric(label: string, value: string): void {
    const input = root.querySelector(
      `input[aria-label="Seam region ${label}"]`,
    ) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('authors using labeled numeric controls and preserves server frame order', () => {
    const select = root.querySelector(
      'select[aria-label="Seam source frame"]',
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      '1: /photos/a.dng',
      '2: /photos/z.dng',
    ]);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    const mode = root.querySelector('select[aria-label="Seam region mode"]') as HTMLSelectElement;
    mode.value = 'exclude';
    mode.dispatchEvent(new Event('change'));
    numeric('X', '20');
    numeric('Y', '30');
    numeric('width', '40');
    numeric('height', '50');
    root
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(editor.constraints()).toEqual({
      version: 1,
      canvas: { width: 1000, height: 400 },
      regions: [{ kind: 'exclude', frame: 1, x: 20, y: 30, width: 40, height: 50 }],
    });
    expect(root.textContent).toContain('Exclude frame 2');
    (root.querySelector('button[aria-label="Remove seam region 1"]') as HTMLButtonElement).click();
    expect(editor.constraints()).toBeNull();
  });

  it('steps numeric values with Enter without adding a region', () => {
    const increase = root.querySelector('button[aria-label="Increase"]') as HTMLButtonElement;
    increase.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    increase.click();
    fixture.detectChanges();
    expect(editor.x()).toBe('1');
    expect(editor.regions()).toHaveLength(0);
    const decrease = root.querySelector('button[aria-label="Decrease"]') as HTMLButtonElement;
    decrease.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    decrease.click();
    fixture.detectChanges();
    expect(editor.x()).toBe('0');
    expect(editor.regions()).toHaveLength(0);
    root
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editor.regions()).toHaveLength(1);
  });

  it('keeps the original reference canvas after a constrained preview changes resolution', () => {
    editor.addNumeric();
    fixture.componentRef.setInput('previewCanvas', { width: 500, height: 200 });
    fixture.detectChanges();
    expect(editor.canvas()).toEqual({ width: 1000, height: 400 });
    editor.x.set('999');
    editor.width.set('2');
    editor.addNumeric();
    expect(editor.regions()).toHaveLength(1);
    expect(editor.error()).toContain('wholly inside');
    editor.clear();
    expect(editor.constraints()).toBeNull();
  });

  it('draws a reversed pointer drag and ignores cancelled drags', () => {
    const surface = root.querySelector('[data-testid="pano-seam-canvas"]') as HTMLElement;
    surface.setPointerCapture = vi.fn();
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 500,
      height: 200,
    } as DOMRect);
    const event = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
      surface.dispatchEvent(event);
    };
    event('pointerdown', 110, 120);
    event('pointermove', 20, 30);
    event('pointerup', 20, 30);
    expect(editor.regions()).toEqual([
      { kind: 'include', frame: 0, x: 20, y: 20, width: 180, height: 180 },
    ]);
    event('pointerdown', 10, 20);
    event('pointercancel', 100, 100);
    event('pointerup', 100, 100);
    expect(editor.regions()).toHaveLength(1);
  });

  it('disables authoring for tile or stale geometry while still allowing regions to be cleared', () => {
    editor.addNumeric();
    fixture.componentRef.setInput('disabledReason', 'Choose Rotation instead of Tile.');
    fixture.detectChanges();
    expect(root.textContent).toContain('Choose Rotation instead of Tile.');
    expect((root.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    editor.addNumeric();
    expect(editor.regions()).toHaveLength(1);
    editor.clear();
    expect(editor.regions()).toHaveLength(0);
  });
});
