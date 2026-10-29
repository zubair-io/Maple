import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, type ActivatedRouteSnapshot } from '@angular/router';
import { ownerGuard } from './auth.guard';
import { AuthService } from './auth.service';

type Role = 'owner' | 'member';

/** `signedInAs` is the session already in memory; `cookieAs` is who a refresh
 * from the cookie would load (a reload starts with no user in memory). */
class FakeAuth {
  private role: Role | null;
  constructor(
    signedInAs: Role | null,
    private readonly cookieAs: Role | null = null,
  ) {
    this.role = signedInAs;
  }
  get isSignedIn(): boolean {
    return this.role !== null;
  }
  get isOwner(): boolean {
    return this.role === 'owner';
  }
  async refresh(): Promise<'refreshed' | 'rejected'> {
    return this.cookieAs ? 'refreshed' : 'rejected';
  }
  async loadMe(): Promise<void> {
    this.role = this.cookieAs;
  }
}

async function runGuard(auth: FakeAuth): Promise<string> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
  });
  const result = await TestBed.runInInjectionContext(() =>
    ownerGuard({} as ActivatedRouteSnapshot, { url: '/settings/pano', root: null as never }),
  );
  return result instanceof UrlTree ? TestBed.inject(Router).serializeUrl(result) : String(result);
}

describe('ownerGuard (#5517)', () => {
  it('lets the owner through', async () => {
    expect(await runGuard(new FakeAuth('owner'))).toBe('true');
  });

  it('checks the role only after a reload has restored the session', async () => {
    expect(await runGuard(new FakeAuth(null, 'owner'))).toBe('true');
  });

  it('sends a signed-in member to their account page', async () => {
    expect(await runGuard(new FakeAuth('member'))).toBe('/settings/account');
  });

  it('sends a member restored by a reload to their account page', async () => {
    expect(await runGuard(new FakeAuth(null, 'member'))).toBe('/settings/account');
  });

  it('sends a signed-out visitor to sign-in with the attempted URL', async () => {
    expect(await runGuard(new FakeAuth(null))).toBe('/sign-in?returnUrl=%2Fsettings%2Fpano');
  });
});
