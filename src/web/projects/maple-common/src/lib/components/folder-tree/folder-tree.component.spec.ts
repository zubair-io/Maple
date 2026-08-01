import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { LibraryStateService } from '../../state/library-state.service';
import { provideFolderTreeExtensions } from './folder-tree-extension';
import { FolderTreeComponent } from './folder-tree.component';

@Component({ standalone: true, template: 'Header action' })
class TestHeaderComponent {}

@Component({ standalone: true, template: 'Body action' })
class TestBodyComponent {}

describe('FolderTreeComponent extensions', () => {
  it('renders app-provided header and body controls in normal-flow slots', () => {
    TestBed.configureTestingModule({
      imports: [FolderTreeComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: { sidebarTree: signal([]) },
        },
        provideFolderTreeExtensions({
          header: TestHeaderComponent,
          body: TestBodyComponent,
        }),
      ],
    });

    const fixture = TestBed.createComponent(FolderTreeComponent);
    fixture.detectChanges();
    const header = fixture.nativeElement.querySelector('.section-bar');

    expect(header.textContent).toContain('Header action');
    expect(header.textContent).not.toContain('Body action');
    expect(fixture.nativeElement.textContent).toContain('Body action');
  });
});
