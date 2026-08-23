import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MAPLE_UI_COLORS, MAPLE_UI_RADIUS, MAPLE_UI_SPACING } from '@maple-common';
import { MapleUiPageComponent } from './maple-ui-page.component';

describe('MapleUiPageComponent', () => {
  let fixture: ComponentFixture<MapleUiPageComponent>;
  let http: HttpTestingController;

  const manifest = [
    { slug: 'badge', title: 'Badge' },
    { slug: 'button', title: 'Button' },
  ];
  const badgeDoc = '# Badge\n\n**Tier:** Atom\n\n## Purpose\n\nA small status indicator.\n';
  const buttonDoc = '# Button\n\n**Tier:** Atom\n\n## Purpose\n\nThe primary control.\n';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MapleUiPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(MapleUiPageComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    http.verify();
  });

  function flushDocs(): void {
    http.expectOne('maple-ui/manifest.json').flush(manifest);
    fixture.detectChanges();
    http.expectOne('maple-ui/badge.md').flush(badgeDoc);
    http.expectOne('maple-ui/button.md').flush(buttonDoc);
    fixture.detectChanges();
  }

  it('renders every color, radius, and spacing token without any fetch', () => {
    flushDocs();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    for (const key of Object.keys(MAPLE_UI_COLORS)) {
      expect(text).toContain(key);
    }
    for (const key of Object.keys(MAPLE_UI_RADIUS)) {
      expect(text).toContain(`radius.${key}`);
    }
    for (const key of Object.keys(MAPLE_UI_SPACING)) {
      expect(text).toContain(`spacing.${key}`);
    }
  });

  it('fetches the manifest and renders one card per contract, markdown converted to HTML', () => {
    flushDocs();
    const host = fixture.nativeElement as HTMLElement;
    const cards = host.querySelectorAll('.contract-card');
    expect(cards.length).toBe(2);
    // Markdown headings become real elements, not literal `#` text.
    expect(host.querySelector('.contract-card h2')?.textContent).toContain('Purpose');
    expect(host.textContent).toContain('A small status indicator.');
    expect(host.textContent).not.toContain('## Purpose');
  });

  it('shows a load error instead of an empty page when the manifest fetch fails', () => {
    http
      .expectOne('maple-ui/manifest.json')
      .flush('nope', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('could not be loaded');
  });
});
