import { sha256Hex } from './sha';

export function hostedSidecarFingerprint(xml: string | null): Promise<string> {
  return xml === null ? Promise.resolve('absent') : sha256Hex(xml);
}
