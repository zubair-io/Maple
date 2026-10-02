import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimelineOwnerFilterComponent } from './timeline-owner-filter.component';
import { AuthService } from '../../../auth/auth.service';
import { TimelineStateService } from '../../../state/timeline-state.service';
import { LibraryStateService } from '../../../state/library-state.service';
import { SearchService } from '../../../api/search.service';
import { API_BASE_URL } from '../../../api/api-base-url.token';
import { LIBRARY_BACKEND } from '../../../api/library-backend.token';
import { provideSelfHostedWorkspace } from '../../../workspace/self-hosted-workspace.providers';
import { clearPrefKeys } from '../timeline-view.test-helpers';

const ME = '111111111111111111111111';
const MEMBER = '222222222222222222222222';

describe('Timeline owner picker', () => {
  let http: HttpTestingController;
  let state: TimelineStateService;
  let library: LibraryStateService;
  let auth: AuthService;
  let fixture: ReturnType<typeof TestBed.createComponent<TimelineOwnerFilterComponent>>;

  beforeEach(() => {
    clearPrefKeys();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    auth.user.set({ id: ME, email: 'me@example.com', role: 'member', file_access: false });
    state = TestBed.inject(TimelineStateService);
    library = TestBed.inject(LibraryStateService);
    fixture = TestBed.createComponent(TimelineOwnerFilterComponent);
    fixture.detectChanges();
    // The real state service reads display preferences on construction.
    for (const request of http.match((r) => r.url !== '/api/search/facets')) {
      request.flush({ show_hidden_images: false });
    }
  });

  afterEach(() => {
    fixture.destroy();
    http.verify({ ignoreCancelled: true });
    clearPrefKeys();
  });

  const facetRequest = () => http.expectOne((r) => r.url === '/api/search/facets');
  function select(value: string): void {
    const element = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    fixture.detectChanges();
  }

  it('uses actual owner ids, without duplicating the signed-in user, and composes the search request', () => {
    const request = facetRequest();
    expect(request.request.params.get('libraryId')).toBeNull();
    expect(request.request.params.get('hasCapturedAt')).toBe('true');
    request.flush({
      owners: [
        { id: ME, email: 'me@example.com', count: 2 },
        { id: MEMBER, email: 'member@example.com', count: 3 },
      ],
    });
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(Array.from(element.options).map((option) => option.text)).toEqual([
      'All owners',
      'Only my uploads',
      'member@example.com',
    ]);
    select(MEMBER);
    expect(state.params()?.ownerId).toBe(MEMBER);
    // Changing ownership does not request a facet list narrowed to that owner.
    http.expectNone((r) => r.url === '/api/search/facets');
    state.setMinRating(4);
    state.setFlag('pick');
    state.setColor('red');
    state.setFrom('2026-01-01');
    state.setTo('2026-12-31');
    state.setHiddenFilter('all');
    fixture.detectChanges();
    const scoped = facetRequest();
    expect(scoped.request.params.get('ownerId')).toBeNull();
    expect(scoped.request.params.get('rating')).toBe('4');
    scoped.flush({ owners: [] });
    fixture.detectChanges();
    // Zero results preserve both selection and the real label.
    expect(element.value).toBe(MEMBER);
    expect(element.selectedOptions[0].text).toBe('member@example.com');
    TestBed.inject(SearchService)
      .search({ ...state.params(), page: 0 })
      .subscribe();
    const results = http.expectOne((r) => r.url === '/api/search');
    for (const [key, value] of Object.entries({
      ownerId: MEMBER,
      rating: '4',
      flag: 'pick',
      color: 'red',
      from: '2026-01-01',
      to: '2026-12-31',
      hidden: 'all',
    })) {
      expect(results.request.params.get(key)).toBe(value);
    }
    results.flush({ results: [], total: 0 });
  });

  it('keeps Only my uploads and All owners usable on legacy servers and clears ownership', () => {
    facetRequest().flush({ total: 0 });
    fixture.detectChanges();
    select(ME);
    expect(state.params()?.ownerId).toBe(ME);
    select('');
    expect(state.params()?.ownerId).toBeUndefined();
    select(ME);
    state.clearAll();
    fixture.detectChanges();
    expect(state.ownerId()).toBe('');
    expect(fixture.nativeElement.querySelector('select').value).toBe('');
  });

  it('cancels abandoned scopes and retries a failed load without losing ownership', () => {
    const abandoned = facetRequest();
    library.searchQuery.set('sunset');
    fixture.detectChanges();
    expect(abandoned.cancelled).toBe(true);
    const latest = facetRequest();
    expect(latest.request.params.get('q')).toBe('sunset');
    latest.flush({}, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not load owners.');
    select(ME);
    fixture.nativeElement.querySelector('[aria-label="Retry loading owners"]').click();
    fixture.detectChanges();
    const retry = facetRequest();
    expect(retry.request.params.get('ownerId')).toBeNull();
    retry.flush({ owners: [{ id: MEMBER, email: MEMBER, count: 1 }] });
    fixture.detectChanges();
    expect(state.params()?.ownerId).toBe(ME);
    expect(fixture.nativeElement.textContent).not.toContain('Could not load owners.');
    select(MEMBER);
    expect(state.params()?.ownerId).toBe(MEMBER);
  });

  it('scopes choices to the selected library and folder and cancels when that scope disappears', () => {
    facetRequest().flush({ owners: [] });
    auth.user.set({ id: ME, email: 'me@example.com', role: 'owner' });
    library.registeredFolders.set([
      {
        id: 'library-id',
        slug: 'photos',
        path: '/Photos',
        label: 'Photos',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01',
      },
    ]);
    library.sidebarTree.set([{ kind: 'folder', id: 'photos:2026', label: '2026', count: null }]);
    library.selectedSourceId.set('photos:2026');
    fixture.detectChanges();
    const request = facetRequest();
    expect(request.request.params.get('libraryId')).toBe('library-id');
    expect(request.request.params.get('pathPrefix')).toBe('2026');
    library.selectedSourceId.set('');
    fixture.detectChanges();
    expect(request.cancelled).toBe(true);
    expect(fixture.nativeElement.querySelector('select').disabled).toBe(true);
  });

  it('tears down an outstanding request when the filter is unmounted', () => {
    const request = facetRequest();
    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });
});
