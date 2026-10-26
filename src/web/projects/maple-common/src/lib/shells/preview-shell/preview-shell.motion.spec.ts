import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFixture } from './preview-shell.test-helpers';

const ACCESS = { apiBase: 'https://maple.test/api', bearer: () => 'token-1' };

function stubHead(ok: boolean) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: ok ? 200 : 404 })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function settled(fixture: ReturnType<typeof setupFixture>['fixture']): Promise<void> {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

const motionButton = (root: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.preview-action-bar button')).find(
    (button) => button.textContent?.trim() === 'Motion',
  );

describe('Full image Motion Photo playback (#5447)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers the Motion control only when the server has a clip for the still', async () => {
    const fetchMock = stubHead(true);
    const { fixture } = setupFixture({ videoAccess: ACCESS });
    await settled(fixture);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://maple.test/api/motion/library/2026/a.jpg?token=token-1',
      { method: 'HEAD' },
    );
    expect(motionButton(fixture.nativeElement)).toBeDefined();
    expect(
      fixture.nativeElement.querySelector(
        '.preview-top-actions button[aria-label="Play Motion Photo"]',
      ),
    ).not.toBeNull();
  });

  it('shows no Motion control for a plain still', async () => {
    stubHead(false);
    const { fixture } = setupFixture({ videoAccess: ACCESS });
    await settled(fixture);
    expect(motionButton(fixture.nativeElement)).toBeUndefined();
  });

  it('plays the clip in place of the still and returns to the still when it ends', async () => {
    stubHead(true);
    const { fixture } = setupFixture({ videoAccess: ACCESS });
    await settled(fixture);
    motionButton(fixture.nativeElement)!.click();
    fixture.detectChanges();
    const player = fixture.nativeElement.querySelector(
      '[data-testid="motion-clip-player"]',
    ) as HTMLVideoElement;
    expect(player.getAttribute('src')).toBe(
      'https://maple.test/api/motion/library/2026/a.jpg?token=token-1',
    );
    expect(player.getAttribute('aria-label')).toBe('Motion Photo clip');
    expect(motionButton(fixture.nativeElement)!.getAttribute('aria-pressed')).toBe('true');

    player.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="motion-clip-player"]')).toBeNull();
  });
});
