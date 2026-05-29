// tab-bar-visibility.service.spec.ts — responsive-program S1a (#597).
// Signal-based service that lets push-mode route components (S4 Loupe,
// S5 Editor) hide the phone shell's bottom tab bar while their content
// is visible, mirroring SwiftUI's `.toolbar(.hidden, for: .tabBar)`.

import { TestBed } from '@angular/core/testing';
import { TabBarVisibilityService } from './tab-bar-visibility.service';

describe('TabBarVisibilityService', () => {
  let service: TabBarVisibilityService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TabBarVisibilityService);
  });

  it('defaults to visible (hidden === false)', () => {
    expect(service.hidden()).toBe(false);
  });

  it('flips the signal when hidden.set(true) is called', () => {
    service.hidden.set(true);
    expect(service.hidden()).toBe(true);
  });

  it('flips back when set(false)', () => {
    service.hidden.set(true);
    service.hidden.set(false);
    expect(service.hidden()).toBe(false);
  });

  it('is providedIn root — same instance across injections', () => {
    const other = TestBed.inject(TabBarVisibilityService);
    expect(other).toBe(service);
  });
});
