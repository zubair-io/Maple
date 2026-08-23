import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPreviewSurfaceComponent } from './mui-preview-surface.component';
import type { MuiPreviewSurfaceItem } from './mui-preview-surface.component';

const ITEMS: readonly MuiPreviewSurfaceItem[] = [
  { id: 'a', kind: 'image', src: 'a.jpg', alt: 'Photo A' },
  { id: 'b', kind: 'video', src: 'b.mp4', alt: 'Clip B' },
];

function render(
  items: readonly MuiPreviewSurfaceItem[] = ITEMS,
): ComponentFixture<MuiPreviewSurfaceComponent> {
  TestBed.configureTestingModule({ imports: [MuiPreviewSurfaceComponent] });
  const fixture = TestBed.createComponent(MuiPreviewSurfaceComponent);
  fixture.componentRef.setInput('items', items);
  fixture.componentRef.setInput('activeId', items[0]?.id ?? null);
  fixture.detectChanges();
  return fixture;
}

describe('MuiPreviewSurfaceComponent', () => {
  it('clicking a filmstrip item fires activeChanged with its id and updates activeItem', () => {
    const fixture = render();
    let changed: string | null = null;
    fixture.componentInstance.activeChanged.subscribe((id: string) => (changed = id));

    const cells = fixture.nativeElement.querySelectorAll('.mui-media-cell');
    (cells[1] as HTMLElement).click();
    fixture.detectChanges();

    expect(changed).toBe('b');
    expect(fixture.componentInstance.activeItem()?.id).toBe('b');
  });

  it('renders mui-video-player for a video item and mui-preview-image for an image item', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-preview-image')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mui-video-player')).toBeNull();

    fixture.componentInstance.activeId.set('b');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-video-player')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mui-preview-image')).toBeNull();
  });

  it('shows the empty-state placeholder instead of the filmstrip when items is empty', () => {
    const fixture = render([]);
    expect(fixture.nativeElement.querySelector('.empty-state')?.textContent).toContain(
      'No media to preview',
    );
    expect(fixture.nativeElement.querySelector('mui-filmstrip-row')).toBeNull();
    expect(fixture.nativeElement.querySelector('mui-page-header')).not.toBeNull();
  });
});
