import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFrameTimeHudComponent } from './mui-frame-time-hud.component';

function render(): ComponentFixture<MuiFrameTimeHudComponent> {
  TestBed.configureTestingModule({ imports: [MuiFrameTimeHudComponent] });
  const fixture = TestBed.createComponent(MuiFrameTimeHudComponent);
  fixture.componentRef.setInput('frameMs', 16.2);
  fixture.detectChanges();
  return fixture;
}

describe('MuiFrameTimeHudComponent', () => {
  it('renders a formatted ms + fps readout, deriving fps from frameMs by default', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.readout').textContent).toContain('16.2ms avg');
    expect(fixture.nativeElement.querySelector('.readout').textContent).toContain('62fps'); // round(1000/16.2)
  });

  it('an explicit fps input overrides the derived value', () => {
    const fixture = render();
    fixture.componentRef.setInput('fps', 60);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.readout').textContent).toContain('60fps');
  });

  it('is "good" at/under the frame budget (16ms default)', () => {
    const fixture = render();
    fixture.componentRef.setInput('frameMs', 15);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-frame-time-hud').className).toContain(
      'status-good',
    );
  });

  it('is "warn" between the budget and the hard limit', () => {
    const fixture = render();
    fixture.componentRef.setInput('frameMs', 30);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-frame-time-hud').className).toContain(
      'status-warn',
    );
  });

  it('is "bad" over the hard limit (50ms default)', () => {
    const fixture = render();
    fixture.componentRef.setInput('frameMs', 75);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-frame-time-hud').className).toContain(
      'status-bad',
    );
  });
});
