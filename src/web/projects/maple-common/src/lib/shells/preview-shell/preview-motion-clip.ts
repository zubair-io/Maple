import { computed, effect, signal, untracked, type Signal } from '@angular/core';
import { parseAddress, toApiPath } from '../../addressing/maple-address';
import type { Asset } from '../../models/asset';
import { mediaRouteUrl, type PreviewVideoAccess } from './preview-video-access';

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

interface ClipSource {
  readonly route: 'video' | 'motion';
  readonly apiPath: string;
  readonly probed: boolean;
}

/** Where the focused still's clip streams from: its Live Photo partner, else an embedded Motion Photo clip. */
function clipSource(asset: Asset | null): ClipSource | undefined {
  if (asset?.livePhoto?.role === 'still') {
    const partner = parseAddress(asset.livePhoto.partnerId);
    return partner.slug && partner.relPath
      ? { route: 'video', apiPath: toApiPath(partner), probed: false }
      : undefined;
  }
  const apiPath = motionClipApiPath(asset);
  return apiPath ? { route: 'motion', apiPath, probed: true } : undefined;
}

/**
 * Full image's clip state for the focused still: whether it has a playable
 * clip (an embedded Motion Photo clip confirmed by a HEAD probe per still, or
 * a Live Photo partner the folder listing already reported), and whether the
 * user has asked to play it. The clip URL is minted when playback starts so
 * it carries the current access token rather than one cached at navigation.
 */
export class PreviewMotionClip {
  readonly available = signal(false);
  readonly playing = signal(false);
  readonly src = computed(() => (this.playing() ? this.urlFor(this.source()) : undefined));
  readonly noun = computed(() =>
    this.source()?.route === 'video' ? 'Live Photo' : 'Motion Photo',
  );
  readonly label = computed(() => (this.source()?.route === 'video' ? 'Live' : 'Motion'));
  private readonly source: Signal<ClipSource | undefined>;

  constructor(
    asset: Signal<Asset | null>,
    private readonly access: PreviewVideoAccess | null,
    probe: MotionClipProbe = headProbe,
  ) {
    this.source = computed(() => clipSource(asset()));
    effect((onCleanup) => {
      const source = this.source();
      const url = this.urlFor(source);
      untracked(() => {
        this.available.set(!!url && source?.probed === false);
        this.playing.set(false);
      });
      if (!url || !source?.probed) return;
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

  private urlFor(source: ClipSource | undefined): string | undefined {
    return source ? mediaRouteUrl(this.access, source.route, source.apiPath) : undefined;
  }
}
