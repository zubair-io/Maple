import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiProgressStepComponent } from './mui-progress-step.component';

function render(): ComponentFixture<MuiProgressStepComponent> {
  TestBed.configureTestingModule({ imports: [MuiProgressStepComponent] });
  const fixture = TestBed.createComponent(MuiProgressStepComponent);
  fixture.componentRef.setInput('index', 2);
  fixture.componentRef.setInput('label', 'Review imports');
  fixture.detectChanges();
  return fixture;
}

describe('MuiProgressStepComponent', () => {
  it('shows the numeric index for pending, and a check for done', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.index').textContent.trim()).toBe('2');

    fixture.componentRef.setInput('status', 'done');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.index').textContent.trim()).toBe('✓');
  });

  it('only shows the Continue button while active, and emits continued', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-button')).toBeNull();

    fixture.componentRef.setInput('status', 'active');
    fixture.detectChanges();
    let count = 0;
    fixture.componentInstance.continued.subscribe(() => count++);
    (fixture.nativeElement.querySelector('mui-button .mui-button') as HTMLButtonElement).click();
    expect(count).toBe(1);
  });

  it('maps status to the expected progress value', () => {
    const fixture = render();
    expect(fixture.componentInstance.progressValue()).toBe(0);
    fixture.componentRef.setInput('status', 'active');
    expect(fixture.componentInstance.progressValue()).toBeNull();
    fixture.componentRef.setInput('status', 'done');
    expect(fixture.componentInstance.progressValue()).toBe(100);
  });
});
