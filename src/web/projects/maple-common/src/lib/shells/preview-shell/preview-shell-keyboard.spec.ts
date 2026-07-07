// preview-shell-keyboard.spec.ts — unit tests for the pure key→action mapper.
// Covers every mapping named in the Task 5 brief plus the null fallthrough.

import { describe, it, expect } from 'vitest';
import { previewKeyAction } from './preview-shell-keyboard';

describe('previewKeyAction', () => {
  it('maps arrows to prev/next', () => {
    expect(previewKeyAction('ArrowRight')).toEqual({ kind: 'next' });
    expect(previewKeyAction('ArrowLeft')).toEqual({ kind: 'prev' });
  });

  it('maps 1-5 to rating and 0 to clear', () => {
    expect(previewKeyAction('1')).toEqual({ kind: 'rating', value: 1 });
    expect(previewKeyAction('2')).toEqual({ kind: 'rating', value: 2 });
    expect(previewKeyAction('3')).toEqual({ kind: 'rating', value: 3 });
    expect(previewKeyAction('4')).toEqual({ kind: 'rating', value: 4 });
    expect(previewKeyAction('5')).toEqual({ kind: 'rating', value: 5 });
    expect(previewKeyAction('0')).toEqual({ kind: 'rating', value: 0 });
  });

  it('maps p/x/u to flags', () => {
    expect(previewKeyAction('p')).toEqual({ kind: 'flag', flag: 'pick' });
    expect(previewKeyAction('x')).toEqual({ kind: 'flag', flag: 'reject' });
    expect(previewKeyAction('u')).toEqual({ kind: 'flag', flag: 'unflagged' });
  });

  it('maps uppercase P/X/U to flags too', () => {
    expect(previewKeyAction('P')).toEqual({ kind: 'flag', flag: 'pick' });
    expect(previewKeyAction('X')).toEqual({ kind: 'flag', flag: 'reject' });
    expect(previewKeyAction('U')).toEqual({ kind: 'flag', flag: 'unflagged' });
  });

  it('ignores other keys', () => {
    expect(previewKeyAction('q')).toBeNull();
    expect(previewKeyAction('Enter')).toBeNull();
    expect(previewKeyAction('ArrowUp')).toBeNull();
    expect(previewKeyAction('ArrowDown')).toBeNull();
    expect(previewKeyAction('6')).toBeNull();
  });
});
