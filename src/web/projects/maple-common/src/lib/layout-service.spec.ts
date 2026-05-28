// layout-service.spec.ts — responsive-program S0a (epic #577, ticket #581).
//
// Mirrors MapleLayoutTests.swift boundary cases at 767 / 768 / 1024 / 1025.
// The pure breakpoint function is tested directly; the LayoutService wraps
// it in an Angular signal driven by window.innerWidth + resize listener.
//
// Spec: docs/spec/responsive-program-s0-primitives.md §2 & §5.1.

import { TestBed } from '@angular/core/testing';
import { LayoutService, mapleLayoutFromWidth } from './layout-service';

describe('mapleLayoutFromWidth', () => {
  it('returns phone for the minimum width', () => {
    expect(mapleLayoutFromWidth(0)).toBe('phone');
  });

  it('returns phone just below the tablet threshold', () => {
    expect(mapleLayoutFromWidth(767)).toBe('phone');
  });

  it('returns tablet at the lower boundary (768)', () => {
    expect(mapleLayoutFromWidth(768)).toBe('tablet');
  });

  it('returns tablet inside the range', () => {
    expect(mapleLayoutFromWidth(900)).toBe('tablet');
  });

  it('returns tablet at the upper boundary (1024)', () => {
    expect(mapleLayoutFromWidth(1024)).toBe('tablet');
  });

  it('returns desktop just above the tablet upper (1025)', () => {
    expect(mapleLayoutFromWidth(1025)).toBe('desktop');
  });

  it('returns desktop at a large width', () => {
    expect(mapleLayoutFromWidth(3840)).toBe('desktop');
  });

  it('honors exact integer boundaries on fractional widths', () => {
    expect(mapleLayoutFromWidth(767.99)).toBe('phone');
    expect(mapleLayoutFromWidth(768.0)).toBe('tablet');
    // 1024.0 stays tablet (inclusive upper); anything >1024 is desktop.
    expect(mapleLayoutFromWidth(1024.0)).toBe('tablet');
    expect(mapleLayoutFromWidth(1024.01)).toBe('desktop');
  });

  it('treats negative width defensively as phone', () => {
    expect(mapleLayoutFromWidth(-100)).toBe('phone');
  });
});

describe('LayoutService', () => {
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    // Restore innerWidth so other tests aren't affected.
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    });
  });

  function setWindowWidth(w: number): void {
    Object.defineProperty(window, 'innerWidth', {
      value: w,
      configurable: true,
      writable: true,
    });
  }

  it('reads the initial layout from window.innerWidth on construction', () => {
    setWindowWidth(500);
    const service = TestBed.inject(LayoutService);
    expect(service.layout()).toBe('phone');
  });

  it('reacts to window resize events', () => {
    setWindowWidth(1200);
    const service = TestBed.inject(LayoutService);
    expect(service.layout()).toBe('desktop');

    setWindowWidth(800);
    window.dispatchEvent(new Event('resize'));
    expect(service.layout()).toBe('tablet');

    setWindowWidth(400);
    window.dispatchEvent(new Event('resize'));
    expect(service.layout()).toBe('phone');
  });
});
