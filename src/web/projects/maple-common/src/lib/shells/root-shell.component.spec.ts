// root-shell.component.spec.ts — web responsive foundation (#2279).
// RootShellComponent no longer forks on LayoutService.layout() — it always
// renders the pane <router-outlet />. The phone-tab shell fork (S1a, #597)
// is retired; see docs/superpowers/plans/2026-07-25-web-responsive-desktop.md
// Task 1.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RootShellComponent } from './root-shell.component';

describe('RootShellComponent', () => {
  let fixture: ComponentFixture<RootShellComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RootShellComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(RootShellComponent);
    fixture.detectChanges();
  });

  it('always renders the pane router-outlet (no phone-tab fork)', () => {
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-phone-tab-shell')).toBeNull();
  });
});
