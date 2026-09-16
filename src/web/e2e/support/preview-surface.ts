// Observe actual preview images independently of visual styling. A resolved
// preview may reuse the thumbnail URL; the shell then marks the existing image
// resolved instead of rendering a duplicate. A resolved URL is not a paint:
// callers must verify complete/naturalWidth and visibility before taking evidence.
export const PREVIEW_IMAGE_SELECTOR = '[data-testid="preview-surface"] img';
export const RESOLVED_PREVIEW_SELECTOR = `${PREVIEW_IMAGE_SELECTOR}[data-preview-resolved="true"]`;
