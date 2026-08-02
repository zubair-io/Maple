/**
 * V8 currently propagates shared WebAssembly memory growth asynchronously to
 * other isolates. #2515 disables Rayon on Chromium-family browsers until that
 * runtime contract changes; #2516 tracks safe restoration. One worker isolate
 * can grow memory safely in serial mode.
 */
export interface UserAgentBrand {
  readonly brand: string;
}

export function isChromiumV8Runtime(
  userAgent: string,
  brands: readonly UserAgentBrand[] = [],
): boolean {
  if (
    brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(brand))
  ) {
    return true;
  }
  return /(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent);
}
