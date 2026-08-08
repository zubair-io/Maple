// Platform copy-modifier detection for drag-move (#2644, design doc:
// "default drag = move; the platform copy-modifier = copy"). macOS/iPadOS
// uses Option (`altKey`); Windows/Linux/ChromeOS use Ctrl (`ctrlKey`) — the
// same split every desktop file manager (Finder vs Explorer) uses for
// drag-to-copy, so this matches user expectation rather than inventing a
// Maple-specific key.

/** True when the current UA reports a Mac/iPadOS platform. iPadOS 13+
 * reports as "MacIntel" in `navigator.platform` (Apple's documented Safari
 * desktop-mode spoof), which is what we want here too — iPadOS trackpad/
 * mouse drag uses the same Option modifier as macOS. */
function isApplePlatform(): boolean {
  return /Mac|iPad|iPhone|iPod/.test(navigator.platform ?? navigator.userAgent ?? '');
}

/** Whether `event`'s modifier state requests "copy" instead of the default
 * "move" for a drag-move drop. Accepts any event carrying the standard
 * `MouseEvent`/`KeyboardEvent` modifier fields (CDK's `CdkDragDrop.event`
 * is typed as `MouseEvent | TouchEvent`, and only the former carries these —
 * touch drags have no modifier key, so they always resolve to move). */
export function isCopyModifierEvent(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  return isApplePlatform() ? !!event.altKey : !!(event.ctrlKey || event.metaKey);
}
