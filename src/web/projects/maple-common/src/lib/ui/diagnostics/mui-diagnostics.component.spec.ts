import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiDiagnosticCheck } from './mui-diagnostics.component';
import { MuiDiagnosticsComponent } from './mui-diagnostics.component';

const CHECKS: readonly MuiDiagnosticCheck[] = [
  { id: 'xmp-roundtrip', label: 'XMP sidecar round-trip', status: 'pass' },
  { id: 'raw-core-ffi', label: 'raw-core FFI link', status: 'fail' },
  { id: 'meili-index', label: 'Meilisearch index reachable', status: 'pending' },
];

@Component({
  standalone: true,
  imports: [MuiDiagnosticsComponent],
  template: `
    <mui-diagnostics
      [checks]="checks()"
      [output]="output()"
      [running]="running()"
      (runRequested)="runCount = runCount + 1"
    />
  `,
})
class HostComponent {
  readonly checks = signal<readonly MuiDiagnosticCheck[]>(CHECKS);
  readonly output = signal('');
  readonly running = signal(false);
  runCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiDiagnosticsComponent', () => {
  it('renders one check row per check with a badge variant matching status', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    const badges = Array.from(el.querySelectorAll('mui-badge .pill')) as HTMLElement[];

    expect(badges.map((b) => b.textContent?.trim())).toEqual(['Pass', 'Fail', 'Pending']);
    expect(badges[0].className).toContain('variant-count');
    expect(badges[1].className).toContain('variant-signal');
    expect(badges[2].className).toContain('variant-count');
  });

  it('renders the raw output in the code block', () => {
    const { fixture, host } = render();
    host.output.set('xmp-roundtrip: OK\nraw-core-ffi: FAILED (symbol not found)');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.code')?.textContent).toContain(
      'raw-core-ffi: FAILED',
    );
  });

  it('emits runRequested when Run checks is pressed, and reflects the running state', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const button = () => el.querySelector('.header .mui-button') as HTMLButtonElement;

    button().click();
    expect(host.runCount).toBe(1);

    host.running.set(true);
    fixture.detectChanges();
    expect(button().className).toContain('is-loading');
  });
});
