import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SupportComponent } from './support.component';

describe('SupportComponent', () => {
  let fixture: ComponentFixture<SupportComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SupportComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(SupportComponent);
    fixture.detectChanges();
  });

  it('publishes the support contact and legal links', () => {
    const supportLink = fixture.nativeElement.querySelector(
      'a[href="mailto:help@justmaple.app"]',
    ) as HTMLAnchorElement;
    const routeLinks = Array.from(
      fixture.nativeElement.querySelectorAll('a[routerlink]') as NodeListOf<HTMLAnchorElement>,
    ).map((link) => link.getAttribute('routerlink'));

    expect(supportLink.textContent?.trim()).toBe('help@justmaple.app');
    expect(routeLinks).toEqual(['/', '/privacy', '/terms']);
  });
});
