import { computed, effect, signal, untracked, type Signal } from '@angular/core';
import { parseAddress, toApiPath } from '../../addressing/maple-address';
import type { Asset } from '../../models/asset';
import type { PreviewVideoAccess } from './preview-video-access';

const MOTION_STILL_NAME = /\.(jpe?g|heic|heif)$/i;

export type MotionClipProbe = (url: string) => Promise<boolean>;

const headProbe: MotionClipProbe = (url) =>
  fetch(url, { method: 'HEAD' }).then(
    (response) => response.ok,
    () => false,
  );

/** The `/api/motion` path for a still that could carry an Android Motion
 * Photo clip, or undefined for anything that cannot. */
export function motionClipApiPath(asset: Asset | null): string | undefined {
  if (!asset || asset.isVideo || !MOTION_STILL_NAME.test(asset.filename)) return undefined;
  const address = parseAddress(asset.id);
  return address.slug && address.relPath ? toApiPath(address) : undefined;
}

/**
 * Full image's embedded-clip state for the focused still: whether the server
 * has a playable clip for it (a HEAD probe per still), and whether the user
 * has asked to play it. The clip URL is minted when playback starts so it
 * carries the current access token rather than one cached at navigation.
 */
export class PreviewMotionClip {
  readonly available = signal(false);
  readonly playing = signal(false);
  readonly src = computed(() => (this.playing() ? this.urlFor(this.apiPath()) : undefined));
  private readonly apiPath: Signal<string | undefined>;

  constructor(
    asset: Signal<Asset | null>,
    private readonly access: PreviewVideoAccess | null,
    probe: MotionClipProbe = headProbe,
  ) {
    this.apiPath = computed(() => motionClipApiPath(asset()));
    effect((onCleanup) => {
      const url = this.urlFor(this.apiPath());
      untracked(() => {
        this.available.set(false);
        this.playing.set(false);
      });
      if (!url) return;
      const current = { live: true };
      onCleanup(() => (current.live = false));
      void probe(url).then((ok) => {
        if (current.live) this.available.set(ok);
      });
    });
  }

  toggle(): void {
    this.playing.update((playing) => this.available() && !playing);
  }

  stop(): void {
    this.playing.set(false);
  }

  private urlFor(apiPath: string | undefined): string | undefined {
    const token = this.access?.bearer();
    if (!apiPath || !token || !this.access) return undefined;
    return `${this.access.apiBase}/motion/${apiPath}?${new URLSearchParams({ token })}`;
  }
}
