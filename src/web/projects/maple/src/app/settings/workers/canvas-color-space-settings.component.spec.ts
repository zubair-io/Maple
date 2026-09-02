import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CanvasColorSpacePref, STORAGE_KEYS, TypedStorage } from '@maple-common';
import { CanvasColorSpaceSettingsComponent } from './canvas-color-space-settings.component';

describe('CanvasColorSpaceSettingsComponent (#3191)', () => {
  let fixture: ComponentFixture<CanvasColorSpaceSettingsComponent>;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const segment = (value: 'display-p3' | 'srgb'): HTMLButtonElement => {
    const buttons = Array.from(
      el().querySelectorAll('[data-testid="canvas-color-space-toggle"] .segment'),
    ) as HTMLButtonElement[];
    const index = value === 'display-p3' ? 0 : 1;
    return buttons[index];
  };

  /** Stub `matchMedia` so the gamut-probed default is deterministic across
   * test hosts (jsdom has no real `matchMedia`, and CI runners vary). Only
   * the FIRST call captures `originalMatchMedia`, so a test that re-stubs
   * mid-test (see "falls back to sRGB" below) doesn't clobber it with an
   * already-stubbed value. */
  function stubGamut(supportsP3: boolean): void {
    if (originalMatchMedia === undefined) originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('p3') ? supportsP3 : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(async () => {
    TypedStorage.remove(STORAGE_KEYS.CANVAS_COLOR_SPACE);
    stubGamut(true);
    await TestBed.configureTestingModule({
      imports: [CanvasColorSpaceSettingsComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CanvasColorSpaceSettingsComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    TypedStorage.remove(STORAGE_KEYS.CANVAS_COLOR_SPACE);
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    originalMatchMedia = undefined;
  });

  it('defaults to the gamut-probed value and reports it as a default, not a saved choice', () => {
    expect(el().querySelector('[data-testid="canvas-color-space-status"]')?.textContent).toBe('P3');
    expect(el().querySelector('[data-testid="canvas-color-space-summary"]')?.textContent).toBe(
      'Default (matches this screen)',
    );
  });

  it('falls back to sRGB when the screen does not report the P3 gamut', () => {
    TestBed.resetTestingModule();
    stubGamut(false);
    return TestBed.configureTestingModule({
      imports: [CanvasColorSpaceSettingsComponent],
    })
      .compileComponents()
      .then(() => {
        fixture = TestBed.createComponent(CanvasColorSpaceSettingsComponent);
        fixture.detectChanges();
        expect(el().querySelector('[data-testid="canvas-color-space-status"]')?.textContent).toBe(
          'sRGB',
        );
      });
  });

  it('clicking sRGB persists the choice and updates the row', () => {
    segment('srgb').click();
    fixture.detectChanges();

    expect(el().querySelector('[data-testid="canvas-color-space-status"]')?.textContent).toBe(
      'sRGB',
    );
    expect(el().querySelector('[data-testid="canvas-color-space-summary"]')?.textContent).toBe(
      'Set by you',
    );
    expect(TypedStorage.get<string>(STORAGE_KEYS.CANVAS_COLOR_SPACE)).toBe('srgb');
  });

  it('a saved choice survives a fresh instance of CanvasColorSpacePref', async () => {
    // `CanvasColorSpacePref` reads localStorage once, in its field
    // initializer — the `beforeEach` component creation above already
    // constructed (and cached) the root-injector singleton before this test
    // could set a value, so a fresh injector is required to observe it.
    TypedStorage.set(STORAGE_KEYS.CANVAS_COLOR_SPACE, 'srgb');
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({}).compileComponents();
    const pref = TestBed.inject(CanvasColorSpacePref);
    expect(pref.current()).toBe('srgb');
    expect(pref.isExplicit()).toBe(true);
  });
});
