import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LensProfileRestorer } from './lens-profile-restorer';

const reference = `lcp1:${'a'.repeat(64)}`;
const xmp = `<rdf:Description papp:LensProfile="${reference}"/>`;

describe('lens profile worker cache restoration', () => {
  const select = vi.fn<(xml: string) => Promise<string>>();
  const restoreCached = vi.fn<(reference: string, digest: string) => Promise<boolean>>();
  let restorer: LensProfileRestorer;

  beforeEach(() => {
    select.mockReset().mockResolvedValue(reference);
    restoreCached.mockReset().mockResolvedValue(true);
    restorer = new LensProfileRestorer(select, restoreCached);
  });

  it('avoids parsing ordinary sidecars and scalar GPU ticks', async () => {
    await restorer.restore(null);
    await restorer.restore('<rdf:Description crs:LensProfileEnable="1"/>');
    expect(select).not.toHaveBeenCalled();
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it.each([
    `<rdf:Description alternate:LensProfile="${reference}"/>`,
    `<papp:LensProfile>${reference}</papp:LensProfile>`,
  ])('delegates unusual XML forms to the canonical parser: %s', async (xml) => {
    select.mockResolvedValue(''); // The current Rust parser ignores these forms.
    await restorer.restore(xml);
    expect(select).toHaveBeenCalledWith(xml);
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it('memoizes the complete sidecar, including later attributes after a comment', async () => {
    const secondReference = `lcp1:${'b'.repeat(64)}`;
    select.mockResolvedValueOnce(reference).mockResolvedValueOnce(secondReference);
    const prefix = '<!-- papp:LensProfile="unchanged" -->';
    const first = prefix + xmp;
    await restorer.restore(first);
    await restorer.restore(first);
    expect(select).toHaveBeenCalledTimes(1);
    await restorer.restore(prefix + xmp.replace(reference, secondReference));
    expect(select).toHaveBeenCalledTimes(2);
    expect(restoreCached).toHaveBeenCalledTimes(2);
    expect(restoreCached).toHaveBeenLastCalledWith(secondReference, 'b'.repeat(64));
  });

  it('does no storage work when the core reports disabled corrections', async () => {
    select.mockResolvedValue('');
    await restorer.restore(xmp.replace('/>', ' crs:LensProfileEnable="0"/>'));
    expect(restoreCached).not.toHaveBeenCalled();
  });

  it('lets the renderer decide whether an unavailable cache is required', async () => {
    restoreCached.mockRejectedValue(new Error('Storage denied'));
    await expect(restorer.restore(xmp)).resolves.toBeUndefined();
    expect(restoreCached).toHaveBeenCalledWith(reference, 'a'.repeat(64));
  });

  it('recognizes a successful import across acknowledgement-only changes', async () => {
    restorer.registered(reference);
    select.mockResolvedValue(reference.replace('lcp1:', 'lcp1-ack:'));
    await restorer.restore(xmp);
    expect(restoreCached).not.toHaveBeenCalled();
  });
});
