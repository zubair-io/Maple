import { describe, expect, it } from 'vitest';
import { routes } from './app.routes';

describe('Hosted routes', () => {
  it('does not expose server-backed search, account, or settings routes', () => {
    const paths = routes.map((route) => route.path);

    expect(paths).not.toContain('search');
    expect(paths).not.toContain('settings');
    expect(paths).not.toContain('settings/account');
  });

  it('keeps every supported Hosted destination before the wildcard fallback', () => {
    const paths = routes.map((route) => route.path);

    expect(paths).toEqual([
      '',
      'browse/:slug',
      'browse',
      'edit/:slug',
      'view/:slug',
      'view',
      'library',
      'library/loupe/:id',
      'protocol-handler',
      '**',
    ]);
  });
});
