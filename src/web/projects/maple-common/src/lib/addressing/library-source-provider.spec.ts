import { describe, it, expect } from 'vitest';
import { selectLibrarySourceKey } from './library-source-selector';

describe('selectLibrarySourceKey', () => {
  it('maps self-hosted → "http"', () => {
    expect(selectLibrarySourceKey('self-hosted')).toBe('http');
  });

  it('maps hosted → "fs-access"', () => {
    expect(selectLibrarySourceKey('hosted')).toBe('fs-access');
  });
});
