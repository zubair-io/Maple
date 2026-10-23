import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryPickerModalComponent } from './library-picker-modal.component';
import { LibraryStateService } from '../../state/library-state.service';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { LIBRARY_SOURCE } from '../../addressing/library-source';

describe('Library picker modal ownership', () => {
  let fixture: ComponentFixture<LibraryPickerModalComponent>;
  let http: HttpTestingController;
  let trigger: HTMLButtonElement;
  const visible = signal(false);
  const addLibraryFolder = vi.fn();

  beforeEach(() => {
    visible.set(false);
    addLibraryFolder.mockReset();
    TestBed.configureTestingModule({
      imports: [LibraryPickerModalComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_SOURCE, useValue: {} },
        {
          provide: LibraryStateService,
          useValue: {
            pickerVisible: visible,
            closeLibraryPicker: () => visible.set(false),
            addLibraryFolder,
          },
        },
      ],
    });
    trigger = document.createElement('button');
    trigger.textContent = 'Add source';
    document.body.append(trigger);
    fixture = TestBed.createComponent(LibraryPickerModalComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    trigger.remove();
    http.verify();
    TestBed.resetTestingModule();
  });

  async function open() {
    trigger.focus();
    visible.set(true);
    fixture.detectChanges();
    http.expectOne('/api/fs/roots').flush({ roots: ['/photos'] });
    http
      .expectOne((r) => r.params.get('path') === '/photos')
      .flush({
        path: '/photos',
        parent: null,
        entries: [],
      });
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it.each(['Escape', 'Cancel', 'scrim'] as const)(
    'dismisses by %s and restores the opener',
    async (how) => {
      await open();
      const panel = fixture.nativeElement.querySelector('[role=dialog]') as HTMLElement;
      expect(panel.getAttribute('aria-label')).toBe('Pick a library folder');
      expect(panel.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement).toBe(panel);
      if (how === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else if (how === 'scrim')
        (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
      else {
        const cancel = Array.from(panel.querySelectorAll('button')).find(
          (b) => b.textContent?.trim() === 'Cancel',
        )!;
        cancel.click();
      }
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role=dialog]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it('contains Tab and Shift+Tab within the picker', async () => {
    await open();
    const panel = fixture.nativeElement.querySelector('[role=dialog]') as HTMLElement;
    const first = panel.querySelector('input') as HTMLInputElement;
    const last = Array.from(panel.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Use this folder',
    )!;
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    document.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('retains the picker while registration has not succeeded, then restores focus on success', async () => {
    await open();
    const choose = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (b) => (b as HTMLButtonElement).textContent?.trim() === 'Use this folder',
    ) as HTMLButtonElement;
    choose.click();
    fixture.detectChanges();
    expect(addLibraryFolder).toHaveBeenCalledWith('/photos');
    expect(fixture.nativeElement.querySelector('[role=dialog]')).not.toBeNull();
    visible.set(false);
    fixture.detectChanges();
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus and cancels discovery if destroyed while open', async () => {
    trigger.focus();
    visible.set(true);
    fixture.detectChanges();
    await Promise.resolve();
    const request = http.expectOne('/api/fs/roots');
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
});
