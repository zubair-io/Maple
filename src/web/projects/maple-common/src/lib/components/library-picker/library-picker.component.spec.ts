import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { LibraryPickerComponent } from './library-picker.component';
import { API_BASE_URL } from '../../api/api-base-url.token';

// DOM selectors mirror the template at library-picker.component.html.
// The template uses Tailwind utility classes for styling — these helpers
// pick out the elements the tests need by stable structural/semantic hooks
// (the `.entry` class, the `<code>` path strip, button text, and the lone
// `<input type="checkbox">`) so the spec doesn't depend on utility-class
// churn.
const entryNames = (el: HTMLElement): NodeListOf<HTMLElement> =>
  el.querySelectorAll<HTMLElement>('.entry span:first-child');
const pathStrip = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>('code');
const useButton = (el: HTMLElement): HTMLButtonElement | null => {
  const buttons = el.querySelectorAll<HTMLButtonElement>('button');
  for (const b of Array.from(buttons)) {
    if ((b.textContent ?? '').trim() === 'Use this folder') return b;
  }
  return null;
};
const upButton = (el: HTMLElement): HTMLButtonElement | null => {
  const buttons = el.querySelectorAll<HTMLButtonElement>('button');
  for (const b of Array.from(buttons)) {
    if ((b.textContent ?? '').includes('Up')) return b;
  }
  return null;
};
const showAllToggle = (el: HTMLElement): HTMLInputElement | null =>
  el.querySelector<HTMLInputElement>('input[type="checkbox"]');

describe('LibraryPickerComponent', () => {
  let fixture: ComponentFixture<LibraryPickerComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LibraryPickerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    fixture = TestBed.createComponent(LibraryPickerComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it("loads '/' on init and shows entries", () => {
    const req = http.expectOne((r) => r.url === '/api/fs/list' && r.params.get('path') === '/');
    req.flush({
      path: '/',
      parent: null,
      entries: [
        { name: 'photos', path: '/photos', hasChildren: true },
        { name: 'external', path: '/external', hasChildren: false },
      ],
    });
    fixture.detectChanges();

    const labels = entryNames(fixture.nativeElement);
    expect(labels.length).toBe(2);
    expect(labels[0].textContent).toContain('photos');
  });

  it('navigates into a clicked entry', () => {
    http
      .expectOne((r) => r.params.get('path') === '/')
      .flush({
        path: '/',
        parent: null,
        entries: [{ name: 'photos', path: '/photos', hasChildren: true }],
      });
    fixture.detectChanges();

    const entry = fixture.nativeElement.querySelector('.entry') as HTMLElement;
    entry.click();
    fixture.detectChanges();

    const req = http.expectOne((r) => r.params.get('path') === '/photos');
    req.flush({
      path: '/photos',
      parent: '/',
      entries: [{ name: '2024', path: '/photos/2024', hasChildren: false }],
    });
    fixture.detectChanges();

    const heading = pathStrip(fixture.nativeElement);
    expect(heading?.textContent).toContain('/photos');
  });

  it('emits pick(path) when "Use this folder" is clicked', () => {
    http
      .expectOne((r) => r.params.get('path') === '/')
      .flush({
        path: '/',
        parent: null,
        entries: [],
      });
    fixture.detectChanges();

    let picked: string | null = null;
    fixture.componentInstance.pick.subscribe((p) => (picked = p));

    const useBtn = useButton(fixture.nativeElement);
    expect(useBtn).not.toBeNull();
    useBtn!.click();

    expect(picked).toBe('/');
  });

  it('Up button navigates to parent', () => {
    http
      .expectOne((r) => r.params.get('path') === '/')
      .flush({
        path: '/',
        parent: null,
        entries: [{ name: 'photos', path: '/photos', hasChildren: true }],
      });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.entry') as HTMLElement).click();
    fixture.detectChanges();

    http
      .expectOne((r) => r.params.get('path') === '/photos')
      .flush({
        path: '/photos',
        parent: '/',
        entries: [],
      });
    fixture.detectChanges();

    const upBtn = upButton(fixture.nativeElement);
    expect(upBtn).not.toBeNull();
    expect(upBtn!.disabled).toBe(false);
    upBtn!.click();
    fixture.detectChanges();

    http
      .expectOne((r) => r.params.get('path') === '/')
      .flush({
        path: '/',
        parent: null,
        entries: [],
      });
    fixture.detectChanges();
    const heading = pathStrip(fixture.nativeElement);
    expect(heading?.textContent).toContain('/');
  });

  it('toggles showAll and refetches', () => {
    http
      .expectOne((r) => r.params.get('path') === '/' && !r.params.get('showAll'))
      .flush({
        path: '/',
        parent: null,
        entries: [],
      });
    fixture.detectChanges();

    const toggle = showAllToggle(fixture.nativeElement);
    expect(toggle).not.toBeNull();
    toggle!.click();
    fixture.detectChanges();

    http
      .expectOne((r) => r.params.get('path') === '/' && r.params.get('showAll') === '1')
      .flush({
        path: '/',
        parent: null,
        entries: [{ name: 'etc', path: '/etc', hasChildren: true }],
      });
    fixture.detectChanges();

    const labels = entryNames(fixture.nativeElement);
    expect(labels[0].textContent).toContain('etc');
  });
});
