// phone-tab-shell.component.spec.ts — responsive-program S1a (#597).
// Bottom-nav with 3 routerLinks (Library/Search/Settings), active-link
// highlighting from RouterLinkActive, hidden-class wired to
// TabBarVisibilityService.hidden signal.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { PhoneTabShellComponent } from './phone-tab-shell.component';
import { TabBarVisibilityService } from './tab-bar-visibility.service';

@Component({ standalone: true, template: '' })
class StubComponent {}

describe('PhoneTabShellComponent', () => {
  let fixture: ComponentFixture<PhoneTabShellComponent>;
  let visibility: TabBarVisibilityService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PhoneTabShellComponent],
      providers: [
        provideRouter([
          { path: 'library', component: StubComponent },
          { path: 'search', component: StubComponent },
          { path: 'settings', component: StubComponent },
        ]),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PhoneTabShellComponent);
    visibility = TestBed.inject(TabBarVisibilityService);
    fixture.detectChanges();
  });

  it('renders three bottom-nav links', () => {
    const links = fixture.nativeElement.querySelectorAll('nav.bottom-tabs a');
    expect(links.length).toBe(3);
  });

  it('uses the right routerLinks + labels', () => {
    const links = fixture.nativeElement.querySelectorAll(
      'nav.bottom-tabs a',
    ) as NodeListOf<HTMLAnchorElement>;
    // routerLink resolves to href once the router is configured.
    expect(links[0].getAttribute('href')).toBe('/library');
    expect(links[1].getAttribute('href')).toBe('/search');
    expect(links[2].getAttribute('href')).toBe('/settings');

    const labels = Array.from(links).map((a) => a.querySelector('span')?.textContent?.trim());
    expect(labels).toEqual(['Library', 'Search', 'Settings']);
  });

  it('renders an icon inside each link', () => {
    const icons = fixture.nativeElement.querySelectorAll('nav.bottom-tabs a svg');
    expect(icons.length).toBe(3);
  });

  it('adds .hidden class to nav when TabBarVisibilityService.hidden is true', () => {
    const nav = fixture.nativeElement.querySelector('nav.bottom-tabs') as HTMLElement;
    expect(nav.classList.contains('hidden')).toBe(false);

    visibility.hidden.set(true);
    fixture.detectChanges();
    expect(nav.classList.contains('hidden')).toBe(true);

    visibility.hidden.set(false);
    fixture.detectChanges();
    expect(nav.classList.contains('hidden')).toBe(false);
  });

  it('contains a <router-outlet> for the active tab content', () => {
    const outlet = fixture.nativeElement.querySelector('router-outlet');
    expect(outlet).not.toBeNull();
  });
});
