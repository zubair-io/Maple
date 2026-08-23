import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTranscriptBlockComponent } from './mui-transcript-block.component';
import type { MuiTranscriptEntry } from './mui-transcript-block.component';

const BASE_TIME = new Date('2026-01-01T10:00:00Z').getTime();
const ENTRIES: readonly MuiTranscriptEntry[] = [
  { id: '1', offsetMs: 4000, speaker: 'Sam', text: 'So we beat on...' },
  { id: '2', offsetMs: 9000, text: '...boats against the current.' },
];

function render(): ComponentFixture<MuiTranscriptBlockComponent> {
  TestBed.configureTestingModule({ imports: [MuiTranscriptBlockComponent] });
  const fixture = TestBed.createComponent(MuiTranscriptBlockComponent);
  fixture.componentRef.setInput('baseTime', BASE_TIME);
  fixture.componentRef.setInput('entries', ENTRIES);
  fixture.detectChanges();
  return fixture;
}

describe('MuiTranscriptBlockComponent', () => {
  it('renders one row per entry with speaker and text', () => {
    const fixture = render();
    const rows = fixture.nativeElement.querySelectorAll('.row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Sam');
    expect(rows[0].textContent).toContain('So we beat on...');
    expect(rows[1].querySelector('.speaker')).toBeNull();
  });

  it('offsets each timestamp from baseTime by offsetMs', () => {
    const fixture = render();
    const instance = fixture.componentInstance;
    expect(instance.entryTime(ENTRIES[0])).toBe(BASE_TIME + 4000);
    expect(instance.entryTime(ENTRIES[1])).toBe(BASE_TIME + 9000);
  });
});
