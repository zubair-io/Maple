import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { LibraryPickerComponent } from './library-picker.component';
import { API_BASE_URL } from '../../api/api-base-url.token';

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

    const labels = (fixture.nativeElement as HTMLElement).querySelectorAll('.entry .name');
    expect(labels.length).toBe(2);
    expect(labels[0].textContent).toContain('photos');
  });

  it('navigates into a clicked entry', () => {
    http.expectOne((r) => r.params.get('path') === '/').flush({
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

    const heading = fixture.nativeElement.querySelector('.path') as HTMLElement;
    expect(heading.textContent).toContain('/photos');
  });

  it('emits pick(path) when "Use this folder" is clicked', () => {
    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [],
    });
    fixture.detectChanges();

    let picked: string | null = null;
    fixture.componentInstance.pick.subscribe((p) => (picked = p));

    const useBtn = fixture.nativeElement.querySelector('button.use') as HTMLButtonElement;
    useBtn.click();

    expect(picked).toBe('/');
  });

  it('Up button navigates to parent', () => {
    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [{ name: 'photos', path: '/photos', hasChildren: true }],
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.entry') as HTMLElement).click();
    fixture.detectChanges();

    http.expectOne((r) => r.params.get('path') === '/photos').flush({
      path: '/photos',
      parent: '/',
      entries: [],
    });
    fixture.detectChanges();

    const upBtn = fixture.nativeElement.querySelector('button.up') as HTMLButtonElement;
    expect(upBtn.disabled).toBe(false);
    upBtn.click();
    fixture.detectChanges();

    http.expectOne((r) => r.params.get('path') === '/').flush({
      path: '/',
      parent: null,
      entries: [],
    });
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector('.path') as HTMLElement;
    expect(heading.textContent).toContain('/');
  });

  it('toggles showAll and refetches', () => {
    http.expectOne((r) => r.params.get('path') === '/' && !r.params.get('showAll')).flush({
      path: '/',
      parent: null,
      entries: [],
    });
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('input.show-all') as HTMLInputElement;
    toggle.click();
    fixture.detectChanges();

    http.expectOne((r) => r.params.get('path') === '/' && r.params.get('showAll') === '1').flush({
      path: '/',
      parent: null,
      entries: [{ name: 'etc', path: '/etc', hasChildren: true }],
    });
    fixture.detectChanges();

    const labels = fixture.nativeElement.querySelectorAll('.entry .name');
    expect(labels[0].textContent).toContain('etc');
  });
});
