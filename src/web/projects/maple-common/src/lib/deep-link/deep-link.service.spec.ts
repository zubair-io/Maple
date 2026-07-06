// deep-link.service.spec.ts — assert each URL form lands on the
// expected Router.navigate call. Mocks Router so the test is pure
// routing logic — no live router state, no actual URL changes.
//
// Spec: docs/design/responsive-program/deep-links.md §5.
// Closes #624.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DeepLinkService } from './deep-link.service';

describe('DeepLinkService', () => {
  let service: DeepLinkService;
  let router: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    router = { navigate: vi.fn() };
    TestBed.configureTestingModule({
      providers: [DeepLinkService, { provide: Router, useValue: router }],
    });
    service = TestBed.inject(DeepLinkService);
  });

  // ---------------------------------------------------------------
  // maple:// scheme — the primary form, delivered by .onOpenURL on
  // Apple and by PWA protocol_handlers on Chromium.
  // ---------------------------------------------------------------

  it('routes maple://image/{id} to /view/{id}', () => {
    service.resolve('maple://image/abc123');
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/view', 'abc123']);
  });

  it('routes maple://source/{id} to /library?source={id}', () => {
    service.resolve('maple://source/cloud-1');
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/library'], {
      queryParams: { source: 'cloud-1' },
    });
  });

  it('accepts a URL instance as well as a string', () => {
    service.resolve(new URL('maple://image/xyz'));
    expect(router.navigate).toHaveBeenCalledWith(['/view', 'xyz']);
  });

  // ---------------------------------------------------------------
  // HTTPS query forms — what PWA protocol_handlers delivers after
  // expansion (`%s` is URL-encoded), and what in-app callers send
  // when they pre-build the route.
  // ---------------------------------------------------------------

  it('unwraps the protocol_handlers wrapping (/library/editor/<encoded maple://>)', () => {
    const wrapped = `/library/editor/${encodeURIComponent('maple://image/abc')}`;
    service.resolve(`http://localhost${wrapped}`);
    expect(router.navigate).toHaveBeenCalledWith(['/view', 'abc']);
  });

  it('routes ?image=… to /view/{id}', () => {
    service.resolve('http://localhost/library?image=foo');
    expect(router.navigate).toHaveBeenCalledWith(['/view', 'foo']);
  });

  it('routes ?source=… to /library?source={id}', () => {
    service.resolve('http://localhost/library?source=bar');
    expect(router.navigate).toHaveBeenCalledWith(['/library'], {
      queryParams: { source: 'bar' },
    });
  });

  // ---------------------------------------------------------------
  // Silent-fallback contract — bad input never throws, never
  // triggers a navigate.
  // ---------------------------------------------------------------

  it('ignores maple://image with no id', () => {
    service.resolve('maple://image/');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('ignores unknown maple host', () => {
    service.resolve('maple://settings/general');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('ignores HTTPS URLs that match no deep-link shape', () => {
    service.resolve('http://localhost/about');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('ignores malformed URLs', () => {
    service.resolve('not-a-url');
    // `new URL('not-a-url', 'http://localhost/')` actually succeeds as
    // a relative path, so the parser still produces a URL — but
    // neither path nor query matches a deep link, so no navigation.
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
