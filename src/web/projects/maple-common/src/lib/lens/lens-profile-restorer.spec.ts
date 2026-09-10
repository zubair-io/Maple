// LensProfileRestorer — the render worker's pre-decode restore memo (#3479).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LENS_PROFILE_MISSING_MESSAGE, LensProfileRestorer } from './lens-profile-restorer';

const reference = `lcp1:${'a'.repeat(64)}`;
const xmp = `<rdf:Description papp:LensProfile="${reference}"/>`;

describe('LensProfileRestorer', () => {
  const select = vi.fn<(xml: string) => Promise<string>>();
  const restoreCached = vi.fn<(reference: string, digest: string) => Promise<boolean>>();
  let restorer: LensProfileRestorer;

  beforeEach(() => {
    select.mockReset().mockResolvedValue(reference);
    restoreCached.mockReset().mockResolvedValue(true);
    restorer = new LensProfileRestorer(select, restoreCached);
  });

  it('never parses ordinary sidecars or scalar GPU ticks', async () => {
    expect(await restorer.restore(null)).toBeNull();
    expect(await restorer.restore('<rdf:Description crs:LensProfileEnable="1"/>')).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it.each([
    `<rdf:Description alternate:LensProfile="${reference}"/>`,
    `<papp:LensProfile>${reference}</papp:LensProfile>`,
  ])('delegates unusual XML forms to the canonical parser: %s', async (xml) => {
    select.mockResolvedValue(''); // the Rust parser owns what these mean
    expect(await restorer.restore(xml)).toBeNull();
    expect(select).toHaveBeenCalledWith(xml);
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it('reports a restored profile once, then memoizes the whole sidecar', async () => {
    const prefix = '<!-- papp:LensProfile="unchanged" -->';
    expect(await restorer.restore(prefix + xmp)).toEqual({ reference, available: true });
    expect(await restorer.restore(prefix + xmp)).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
    expect(restoreCached).toHaveBeenCalledTimes(1);
    expect(restoreCached).toHaveBeenCalledWith(reference, 'a'.repeat(64));
  });

  it('re-selects when the sidecar changes, including attributes after a comment', async () => {
    const secondReference = `lcp1:${'b'.repeat(64)}`;
    select.mockResolvedValueOnce(reference).mockResolvedValueOnce(secondReference);
    await restorer.restore(xmp);
    const outcome = await restorer.restore(xmp.replace(reference, secondReference));
    expect(select).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ reference: secondReference, available: true });
    expect(restoreCached).toHaveBeenLastCalledWith(secondReference, 'b'.repeat(64));
  });

  it('does no storage work when the core reports every correction disabled', async () => {
    select.mockResolvedValue('');
    expect(await restorer.restore(xmp.replace('/>', ' crs:LensProfileEnable="0"/>'))).toBeNull();
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it('reports a profile no cache can supply once, and again after a reset', async () => {
    restoreCached.mockResolvedValue(false);
    expect(await restorer.restore(xmp)).toEqual({
      reference,
      available: false,
      message: LENS_PROFILE_MISSING_MESSAGE,
    });
    expect(await restorer.restore(xmp)).toBeNull();
    expect(restoreCached).toHaveBeenCalledTimes(1);
    restorer.reset();
    expect(await restorer.restore(xmp)).not.toBeNull();
    expect(restoreCached).toHaveBeenCalledTimes(2);
  });

  it('surfaces denied storage as unavailable and lets the renderer decide', async () => {
    restoreCached.mockRejectedValue(new Error('Storage denied'));
    expect(await restorer.restore(xmp)).toEqual({
      reference,
      available: false,
      message: 'Storage denied',
    });
  });

  it('surfaces a reference version this build cannot supply', async () => {
    const future = `lcp2:${'c'.repeat(64)}`;
    select.mockResolvedValue(future);
    const outcome = await restorer.restore(xmp.replace(reference, future));
    expect(outcome?.available).toBe(false);
    expect(outcome?.message).toContain('Unsupported lens profile reference');
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it('recognizes an import across acknowledgement-only changes', async () => {
    restorer.registered(reference);
    select.mockResolvedValue(reference.replace('lcp1:', 'lcp1-ack:'));
    expect(await restorer.restore(xmp)).toBeNull();
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it('forgets a missing profile once it is imported', async () => {
    restoreCached.mockResolvedValue(false);
    await restorer.restore(xmp);
    restorer.registered(reference);
    restoreCached.mockResolvedValue(true);
    // Same sidecar, but the digest is now registered: nothing to restore.
    expect(await restorer.restore(xmp)).toBeNull();
    expect(restoreCached).toHaveBeenCalledTimes(1);
  });
});
