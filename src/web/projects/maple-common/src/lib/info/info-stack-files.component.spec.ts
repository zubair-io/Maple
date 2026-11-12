import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { InfoStackFilesComponent } from './info-stack-files.component';
import { formatFileSize, stackFileRows } from './info-stack-files.vm';
import type { Asset } from '../models/asset';

const STACKED: Asset = {
  id: 'lib:IMG_1.CR3',
  filename: 'IMG_1.CR3',
  folderId: 'lib:',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  size: 25 * 1024 * 1024,
  stack: {
    companion: { id: 'lib:IMG_1.JPG', name: 'IMG_1.JPG', ext: 'jpg', size: 4 * 1024 * 1024 },
  },
};

function render(asset: Asset | null) {
  TestBed.configureTestingModule({ imports: [InfoStackFilesComponent] });
  const fixture = TestBed.createComponent(InfoStackFilesComponent);
  fixture.componentRef.setInput('asset', asset);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('InfoStackFilesComponent', () => {
  it('lists both files with name, type and size, and marks the RAW primary', () => {
    const rows = [...render(STACKED).querySelectorAll('.stack-file-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('IMG_1.CR3');
    expect(rows[0]!.textContent).toContain('RAW · 25 MB');
    expect(rows[0]!.getAttribute('data-primary')).toBe('true');
    expect(rows[0]!.textContent).toContain('Primary');
    expect(rows[1]!.textContent).toContain('IMG_1.JPG');
    expect(rows[1]!.textContent).toContain('JPEG · 4.0 MB');
    expect(rows[1]!.getAttribute('data-primary')).toBe('false');
    expect(rows[1]!.textContent).not.toContain('Primary');
  });

  it('renders nothing for an unstacked asset or no asset', () => {
    expect(render({ ...STACKED, stack: undefined }).querySelector('.stack-file-row')).toBeNull();
    TestBed.resetTestingModule();
    expect(render(null).querySelector('.stack-file-row')).toBeNull();
  });
});

describe('stack file view-model', () => {
  it('reads an unknown RAW size as a dash', () => {
    expect(stackFileRows({ ...STACKED, size: undefined })[0]!.size).toBe('—');
  });

  it('formats byte counts compactly', () => {
    expect([0, 900, 2048, 13478912].map(formatFileSize)).toEqual([
      '0 B',
      '900 B',
      '2.0 KB',
      '13 MB',
    ]);
  });
});
