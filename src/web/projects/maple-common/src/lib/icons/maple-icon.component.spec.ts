// MapleIcon — unit tests for the chrome-glyph registry shipped in S0c
// (responsive program, see docs/spec/responsive-program-s0-icons.md).
//
// Per spec §5.3, one test per ADDED glyph: render <maple-icon name="X">,
// assert the resulting <svg> contains the expected primitives. Mechanical,
// tiny, but catches typos in the registry path/circle/rect data.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { Component } from '@angular/core';

import { MapleIconComponent, type MapleIconName } from './maple-icon.component';
import { ICON_SHAPES } from './maple-icon-registry';

@Component({
  selector: 'test-host',
  standalone: true,
  imports: [MapleIconComponent],
  template: `<maple-icon [name]="name" />`,
})
class HostComponent {
  name: MapleIconName = 'plus';
}

function render(name: MapleIconName): SVGSVGElement {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.name = name;
  fixture.detectChanges();
  const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
  expect(svg).toBeTruthy();
  return svg;
}

describe('MapleIconComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();
  });

  describe('container <svg>', () => {
    it('uses the 16×16 viewBox convention', () => {
      const svg = render('plus');
      expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
    });
  });

  // ---- Glyphs added in S0c ----
  // Each test renders the glyph and verifies the registry shape data lands
  // in the DOM with the expected primitive (path d=…, circle cx/cy/r,
  // rect x/y/w/h). Asserting against ICON_SHAPES catches both the
  // registry omission (missing name in the union) and template wiring
  // regressions (e.g. an attribute binding that drops `d`).

  describe('chevron-left (new in S0c)', () => {
    it('renders the mirrored chevron path', () => {
      const svg = render('chevron-left');
      const paths = svg.querySelectorAll('path');
      expect(paths.length).toBe(1);
      expect(paths[0].getAttribute('d')).toBe('M10 3l-5 5 5 5');
      expect(ICON_SHAPES['chevron-left']).toEqual([{ kind: 'path', d: 'M10 3l-5 5 5 5' }]);
    });
  });

  describe('ellipsis-horizontal (new in S0c)', () => {
    it('renders three filled circles along y=8', () => {
      const svg = render('ellipsis-horizontal');
      const circles = svg.querySelectorAll('circle');
      expect(circles.length).toBe(3);
      const xs = Array.from(circles).map((c) => Number(c.getAttribute('cx')));
      expect(xs).toEqual([4, 8, 12]);
      for (const c of Array.from(circles)) {
        expect(c.getAttribute('cy')).toBe('8');
        expect(c.getAttribute('r')).toBe('1');
        // filled: true → fill=currentColor (resolved), stroke=null
        expect(c.getAttribute('stroke')).toBeNull();
      }
    });
  });

  describe('share-up-square (new in S0c)', () => {
    it('renders an up-arrow + tray composition', () => {
      const svg = render('share-up-square');
      const paths = svg.querySelectorAll('path');
      // Two paths: the up-arrow (shaft + head) and the tray base.
      expect(paths.length).toBeGreaterThanOrEqual(2);
      const shapes = ICON_SHAPES['share-up-square'];
      expect(shapes.length).toBeGreaterThanOrEqual(2);
      // The arrow shaft sits centred on x=8 starting near the top.
      const arrowPath = shapes.find((s) => s.kind === 'path' && s.d.includes('M8 2'));
      expect(arrowPath).toBeDefined();
    });
  });

  describe('undo-uturn (new in S0c)', () => {
    it('renders the u-turn half-loop returning left', () => {
      const svg = render('undo-uturn');
      const paths = svg.querySelectorAll('path');
      expect(paths.length).toBeGreaterThanOrEqual(1);
      const shapes = ICON_SHAPES['undo-uturn'];
      // Arrow head points left → first move is to a small x.
      const head = shapes.find((s) => s.kind === 'path' && s.d.startsWith('M2.5 6'));
      expect(head).toBeDefined();
    });
  });

  describe('redo-uturn (new in S0c)', () => {
    it('renders the u-turn half-loop returning right (mirror of undo)', () => {
      const svg = render('redo-uturn');
      const paths = svg.querySelectorAll('path');
      expect(paths.length).toBeGreaterThanOrEqual(1);
      const shapes = ICON_SHAPES['redo-uturn'];
      const head = shapes.find((s) => s.kind === 'path' && s.d.startsWith('M13.5 6'));
      expect(head).toBeDefined();
    });
  });

  describe('clear-circle-fill (new in S0c)', () => {
    it('renders a single filled path with evenodd fill-rule (X cut out)', () => {
      // The disc + X are merged into one filled <path> with fill-rule=evenodd
      // so the X subtracts from the disc fill and reads as the page background
      // (otherwise both the disc and the X would render in `currentColor` and
      // the X would disappear into the disc — see PR #589 review thread).
      const svg = render('clear-circle-fill');
      const paths = svg.querySelectorAll('path');
      const circles = svg.querySelectorAll('circle');
      expect(paths.length).toBe(1);
      expect(circles.length).toBe(0);
      const p = paths[0];
      // Filled, not stroked.
      expect(p.getAttribute('fill')).not.toBe('none');
      expect(p.getAttribute('stroke')).toBeNull();
      // evenodd is what makes the cutout work.
      expect(p.getAttribute('fill-rule')).toBe('evenodd');
      // Path data has two subpaths: the disc (begins with M2.5 8 + arc) and
      // the X polygon (begins with a later M…). Both end with Z.
      const d = p.getAttribute('d') ?? '';
      expect(d.startsWith('M2.5 8A5.5 5.5 0 1 0 13.5 8')).toBe(true);
      // Two subpaths → exactly two Z terminators.
      expect((d.match(/Z/g) ?? []).length).toBe(2);
      // The X subpath traces 12 vertices through the cardinal crotches
      // (8, 6.94) / (9.06, 8) / (8, 9.06) / (6.94, 8).
      expect(d).toContain('M8 6.94');
      expect(d).toContain('9.06 8');
      expect(d).toContain('8 9.06');
      expect(d).toContain('6.94 8');
    });
  });

  describe('smart-source-wand (new in S0c)', () => {
    it('renders a wand staff plus sparkle accent', () => {
      const svg = render('smart-source-wand');
      const shapes = ICON_SHAPES['smart-source-wand'];
      // Two paths: the diagonal wand staff and the sparkle.
      expect(shapes.length).toBeGreaterThanOrEqual(2);
      const staff = shapes.find((s) => s.kind === 'path' && s.d === 'M3 13L11 5');
      expect(staff).toBeDefined();
    });
  });

  describe('album-stack (new in S0c)', () => {
    it('renders three offset stacked rectangles', () => {
      const svg = render('album-stack');
      const rects = svg.querySelectorAll('rect');
      expect(rects.length).toBe(3);
      // Three rects offset vertically: top peeks above middle peeks above front.
      const ys = Array.from(rects).map((r) => Number(r.getAttribute('y')));
      // Sorted ascending: back-most rect highest on screen (smallest y).
      const sorted = [...ys].sort((a, b) => a - b);
      expect(sorted).toEqual(ys);
    });
  });

  describe('keyword-hash (new in S0c)', () => {
    it('renders the # glyph (two verticals + two horizontals)', () => {
      const svg = render('keyword-hash');
      const paths = svg.querySelectorAll('path');
      expect(paths.length).toBe(1);
      expect(paths[0].getAttribute('d')).toBe('M6 2.5l-1 11M11 2.5l-1 11M3 6h10M3 10h10');
    });
  });

  describe('person-circle (new in S0c)', () => {
    it('renders an outer circle, a head circle, and shoulders path', () => {
      const svg = render('person-circle');
      const circles = svg.querySelectorAll('circle');
      const paths = svg.querySelectorAll('path');
      // Outer face circle + head circle = 2 circles, shoulders = 1 path.
      expect(circles.length).toBe(2);
      expect(paths.length).toBe(1);
      // Outer is the larger one.
      const radii = Array.from(circles).map((c) => Number(c.getAttribute('r')));
      expect(Math.max(...radii)).toBe(5.5);
    });
  });
});
