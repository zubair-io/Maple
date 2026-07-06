// protocol-handler.component.spec.ts — PWA polish (#620) + M2 path routing (#1327).
// Covers the URL-parsing helper directly (cheap, no router needed) and a
// thin component-level test that the redirect actually happens.

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { NavigationEnd, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { filter, firstValueFrom } from 'rxjs';
import { ProtocolHandlerComponent, parseProtocolUrl } from './protocol-handler.component';

describe('parseProtocolUrl', () => {
  it('returns null for null / empty input', () => {
    expect(parseProtocolUrl(null)).toBeNull();
    expect(parseProtocolUrl('')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(parseProtocolUrl('not a url')).toBeNull();
  });

  it('rejects unsupported schemes', () => {
    expect(parseProtocolUrl('https://example.com/image/abc')).toBeNull();
    expect(parseProtocolUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects unknown hosts', () => {
    expect(parseProtocolUrl('web+maple://unknown/abc')).toBeNull();
  });

  it('rejects image URLs with no id', () => {
    expect(parseProtocolUrl('web+maple://image/')).toBeNull();
    expect(parseProtocolUrl('web+maple://image')).toBeNull();
  });

  it('parses web+maple://image/<id>', () => {
    expect(parseProtocolUrl('web+maple://image/abc123')).toEqual(['/view', 'abc123']);
  });

  it('parses bare maple://image/<id> (iOS scheme)', () => {
    expect(parseProtocolUrl('maple://image/xyz')).toEqual(['/view', 'xyz']);
  });

  it('decodes percent-encoded ids', () => {
    expect(parseProtocolUrl('web+maple://image/fs%3A%2Ffoo%2Fbar.dng')).toEqual([
      '/view',
      'fs:/foo/bar.dng',
    ]);
  });

  // M2 path-based routing (#1327): browse + edit deep-links using MapleAddress
  // grammar (slug:relPath). The protocol handler maps:
  //   maple://browse/<slug>/<...relPath segments>  →  /browse/:slug/**
  //   maple://edit/<slug>/<...relPath segments>    →  /edit/:slug/**
  it('parses maple://browse/<slug> (root folder)', () => {
    expect(parseProtocolUrl('maple://browse/my-library')).toEqual(['/browse', 'my-library']);
  });

  it('parses maple://browse/<slug>/<relPath> (sub-folder)', () => {
    expect(parseProtocolUrl('maple://browse/my-library/2024/jan')).toEqual([
      '/browse',
      'my-library',
      '2024',
      'jan',
    ]);
  });

  it('parses maple://edit/<slug>/<relPath> (image deep-link)', () => {
    expect(parseProtocolUrl('maple://edit/my-library/shots/img_001.dng')).toEqual([
      '/edit',
      'my-library',
      'shots',
      'img_001.dng',
    ]);
  });

  it('rejects maple://browse with no slug', () => {
    expect(parseProtocolUrl('maple://browse/')).toBeNull();
    expect(parseProtocolUrl('maple://browse')).toBeNull();
  });

  it('rejects maple://edit with no slug', () => {
    expect(parseProtocolUrl('maple://edit/')).toBeNull();
    expect(parseProtocolUrl('maple://edit')).toBeNull();
  });

  it('parses web+maple://browse/<slug>/<path> correctly', () => {
    expect(parseProtocolUrl('web+maple://browse/my-library/2024')).toEqual([
      '/browse',
      'my-library',
      '2024',
    ]);
  });
});

@Component({ standalone: true, template: 'stub' })
class StubComponent {}

describe('ProtocolHandlerComponent', () => {
  let harness: RouterTestingHarness;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'protocol-handler', component: ProtocolHandlerComponent },
          { path: 'library', component: StubComponent },
          { path: 'view/:id', component: StubComponent },
        ]),
      ],
    }).compileComponents();
    harness = await RouterTestingHarness.create();
    router = TestBed.inject(Router);
  });

  // ngOnInit calls router.navigate asynchronously, so the initial
  // navigateByUrl resolves on the NavigationEnd for /protocol-handler
  // *before* the redirect navigation is even queued. Wait for the next
  // NavigationEnd after navigateByUrl settles to observe the final URL.
  async function expectRedirectTo(initialUrl: string, finalUrl: string) {
    await harness.navigateByUrl(initialUrl);
    await firstValueFrom(
      router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)),
    );
    expect(router.url).toBe(finalUrl);
  }

  it('redirects to /view/<id> for a valid web+maple URL', async () => {
    await expectRedirectTo('/protocol-handler?url=web%2Bmaple%3A%2F%2Fimage%2Fabc', '/view/abc');
  });

  it('falls back to /library when the url param is missing', async () => {
    await expectRedirectTo('/protocol-handler', '/library');
  });

  it('falls back to /library when the scheme is unsupported', async () => {
    await expectRedirectTo(
      '/protocol-handler?url=https%3A%2F%2Fevil.example%2Fimage%2Fabc',
      '/library',
    );
  });
});
