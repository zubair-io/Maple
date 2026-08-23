import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTemplateGalleryModalComponent } from './mui-template-gallery-modal.component';
import type { MuiGalleryTemplate } from './mui-template-gallery-modal.component';

const TEMPLATES: MuiGalleryTemplate[] = [
  {
    id: 't1',
    name: 'Golden Hour',
    thumbnailUrl: 'a.jpg',
    description: 'Warm tones',
    category: 'Landscape',
  },
  {
    id: 't2',
    name: 'Moody Portrait',
    thumbnailUrl: 'b.jpg',
    description: 'Cool shadows',
    category: 'Portrait',
  },
];

@Component({
  standalone: true,
  imports: [MuiTemplateGalleryModalComponent],
  template: `
    <mui-template-gallery-modal
      [open]="open()"
      [templates]="templates()"
      [(search)]="search"
      (templateApplied)="applied = $event"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly templates = signal<readonly MuiGalleryTemplate[]>(TEMPLATES);
  readonly search = signal('');
  applied: MuiGalleryTemplate | null = null;
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiTemplateGalleryModalComponent', () => {
  it('renders one card per template', () => {
    const { fixture } = render();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('mui-card').length).toBe(2);
  });

  it('filters templates by search text across name and description', () => {
    const { fixture, host } = render();
    host.search.set('moody');
    fixture.detectChanges();
    const cards = (fixture.nativeElement as HTMLElement).querySelectorAll('mui-card');
    expect(cards.length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Moody Portrait');
  });

  it('shows the empty state when no template matches the search', () => {
    const { fixture, host } = render();
    host.search.set('nonexistent');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('mui-card').length).toBe(0);
    expect(el.querySelector('mui-empty-state')).not.toBeNull();
  });

  it('emits templateApplied with the pressed template', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-card .mui-card') as HTMLElement).click();
    expect(host.applied?.id).toBe('t1');
  });

  it('emits dismissed on scrim click', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
