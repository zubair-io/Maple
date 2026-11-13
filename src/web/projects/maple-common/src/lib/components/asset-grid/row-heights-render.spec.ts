import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { afterEach, describe, expect, it } from 'vitest';
import { RowHeightsVirtualScrollDirective } from './row-heights-virtual-scroll';

@Component({
  standalone: true,
  imports: [ScrollingModule, RowHeightsVirtualScrollDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <cdk-virtual-scroll-viewport [mapleRowHeights]="heights()" style="height: 400px">
      <div *cdkVirtualFor="let row of rows()" style="height: 100px">{{ row }}</div>
    </cdk-virtual-scroll-viewport>
  `,
})
class GridHost {
  readonly rows = signal<string[]>([]);
  readonly heights = computed(() => this.rows().map(() => 100));
}

describe('row heights with the real CDK row renderer', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(initial: string[] = []) {
    TestBed.configureTestingModule({ imports: [GridHost] });
    const fixture = TestBed.createComponent(GridHost);
    fixture.componentInstance.rows.set(initial);
    fixture.autoDetectChanges();
    return fixture;
  }

  it('renders a populated first frame', async () => {
    const fixture = render(['one.dng', 'two.dng']);
    await fixture.whenStable();
    await expect.poll(() => fixture.nativeElement.textContent).toContain('one.dng');
    expect(fixture.nativeElement.textContent).toContain('two.dng');
  });

  it('renders rows arriving after the empty viewport without another user action', async () => {
    const fixture = render();
    await fixture.whenStable();
    fixture.componentInstance.rows.set(['one.dng', 'two.dng']);
    await fixture.whenStable();
    const content = fixture.nativeElement.querySelector('.cdk-virtual-scroll-content-wrapper');
    await expect.poll(() => content.textContent).toContain('one.dng');
    expect(content.textContent).toContain('two.dng');
  });

  it('clears and refills on folder changes, including replacement with the same row count', async () => {
    const fixture = render(['old.dng']);
    await fixture.whenStable();
    fixture.componentInstance.rows.set([]);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('old.dng');
    fixture.componentInstance.rows.set(['new.dng']);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('new.dng');
    fixture.componentInstance.rows.set(['other.dng']);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('other.dng');
    expect(fixture.nativeElement.textContent).not.toContain('new.dng');
  });
});
