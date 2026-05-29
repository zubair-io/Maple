// root-shell.component.spec.ts — responsive-program S1a (#597).
// Dispatches the active shell based on LayoutService.layout(). Phone tier
// renders PhoneTabShellComponent; tablet / desktop fall through to a
// <router-outlet /> for the existing pane shell routes.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { RootShellComponent } from './root-shell.component';
import { LayoutService, type MapleLayout } from '../layout-service';

class StubLayoutService {
  readonly layout = signal<MapleLayout>('desktop');
}

describe('RootShellComponent', () => {
  let fixture: ComponentFixture<RootShellComponent>;
  let stub: StubLayoutService;

  beforeEach(async () => {
    stub = new StubLayoutService();
    await TestBed.configureTestingModule({
      imports: [RootShellComponent],
      providers: [provideRouter([]), { provide: LayoutService, useValue: stub }],
    }).compileComponents();

    fixture = TestBed.createComponent(RootShellComponent);
  });

  it('renders <app-phone-tab-shell> when layout === phone', () => {
    stub.layout.set('phone');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-phone-tab-shell')).not.toBeNull();
    // No bare router-outlet at this level when phone shell takes over.
    expect(fixture.nativeElement.querySelector(':scope > router-outlet')).toBeNull();
  });

  it('renders the pane <router-outlet /> when layout === tablet', () => {
    stub.layout.set('tablet');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-phone-tab-shell')).toBeNull();
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });

  it('renders the pane <router-outlet /> when layout === desktop', () => {
    stub.layout.set('desktop');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-phone-tab-shell')).toBeNull();
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });

  it('swaps shells when the layout signal flips at runtime', () => {
    stub.layout.set('desktop');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();

    stub.layout.set('phone');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-phone-tab-shell')).not.toBeNull();
  });
});
