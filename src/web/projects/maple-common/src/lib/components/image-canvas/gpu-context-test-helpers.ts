// Test-only jsdom stub for a secure, WebGPU-capable browser (#2415). jsdom
// never sets `isSecureContext` / `navigator.gpu` at all — several specs need
// to represent a real capable browser to reach the GPU session-open path
// (`ImageCanvasGpuPresent.hasSecureGpuContext()`), so this centralizes the
// patch/restore pair rather than duplicating it per spec file.

export interface SecureGpuContextPatch {
  /** Undo the patch, restoring whatever property (or absence of one) jsdom
   * had before `patchSecureGpuContext()` ran. */
  restore(): void;
}

export function patchSecureGpuContext(): SecureGpuContextPatch {
  const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  const originalNavigatorGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });

  return {
    restore(): void {
      if (originalIsSecureContext) {
        Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
      } else {
        delete (window as unknown as { isSecureContext?: boolean }).isSecureContext;
      }
      if (originalNavigatorGpu) {
        Object.defineProperty(navigator, 'gpu', originalNavigatorGpu);
      } else {
        delete (navigator as unknown as { gpu?: unknown }).gpu;
      }
    },
  };
}
