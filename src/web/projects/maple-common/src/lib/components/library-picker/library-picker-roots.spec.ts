import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryPickerComponent } from './library-picker.component';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { LIBRARY_SOURCE } from '../../addressing/library-source';

describe('Library picker allowed roots', () => {
  let fixture: ComponentFixture<LibraryPickerComponent>;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LibraryPickerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_SOURCE, useValue: {} },
      ],
    });
    fixture = TestBed.createComponent(LibraryPickerComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    http.verify();
    TestBed.resetTestingModule();
  });

  function list(path: string) {
    const request = http.expectOne(
      (r) => r.url === '/api/fs/list' && r.params.get('path') === path,
    );
    request.flush({ path, parent: null, entries: [] });
    fixture.detectChanges();
  }

  it('discovers the permitted start instead of requesting the forbidden filesystem root', () => {
    http.expectNone('/api/fs/list');
    http.expectOne('/api/fs/roots').flush({ roots: ['/srv/photos'] });
    list('/srv/photos');
    expect(fixture.nativeElement.querySelector('code').textContent).toContain('/srv/photos');
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);
    fixture.componentInstance.onUseHere();
    expect(pick).toHaveBeenCalledWith('/srv/photos');
  });

  it('lets the owner switch among all permitted roots and cancels the previous listing', () => {
    http.expectOne('/api/fs/roots').flush({ roots: ['/srv/photos', '/mnt/archive'] });
    const previous = http.expectOne((r) => r.params.get('path') === '/srv/photos');
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.getAttribute('aria-label')).toBe('Filesystem root');
    select.value = '/mnt/archive';
    select.dispatchEvent(new Event('change'));
    expect(previous.cancelled).toBe(true);
    list('/mnt/archive');
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);
    fixture.componentInstance.onUseHere();
    expect(pick).toHaveBeenCalledWith('/mnt/archive');
  });

  it('does not choose a stale folder while a different root is loading or has failed', () => {
    http.expectOne('/api/fs/roots').flush({ roots: ['/photos', '/offline'] });
    list('/photos');
    fixture.componentInstance.onRootChange('/offline');
    expect(fixture.componentInstance.canChoose()).toBe(false);
    http
      .expectOne((r) => r.params.get('path') === '/offline')
      .flush({ error: 'Cannot access offline volume' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);
    fixture.componentInstance.onUseHere();
    expect(pick).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain('offline');
    fixture.componentInstance.retry();
    list('/offline');
    expect(fixture.componentInstance.canChoose()).toBe(true);
  });

  it('shows discovery failure and retries without guessing a root', () => {
    http
      .expectOne('/api/fs/roots')
      .flush({ error: 'File access denied' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain('denied');
    expect(fixture.componentInstance.canChoose()).toBe(false);
    http.expectNone('/api/fs/list');
    const retry = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.trim() === 'Retry loading folders',
    ) as HTMLButtonElement;
    retry.click();
    http.expectOne('/api/fs/roots').flush({ roots: ['/allowed'] });
    list('/allowed');
    expect(fixture.componentInstance.canChoose()).toBe(true);
  });

  it('reports an empty root set without requesting or choosing slash', () => {
    http.expectOne('/api/fs/roots').flush({ roots: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role=alert]').textContent).toContain(
      'No filesystem roots',
    );
    expect(fixture.componentInstance.canChoose()).toBe(false);
    http.expectNone('/api/fs/list');
  });

  it('disables Show system folders during discovery and cancels lookup on dismissal', () => {
    const request = http.expectOne('/api/fs/roots');
    expect(fixture.nativeElement.querySelector('input').disabled).toBe(true);
    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });
});
