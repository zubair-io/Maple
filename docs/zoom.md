# Zoom System

The zoom system provides pixel-perfect viewing at any magnification from fit-to-window through 800%, with retina-aware rendering that produces crisp output on high-DPI displays.

---

## Coordinate System

`pixelScale` is defined as **real screen pixels per image pixel**:

| pixelScale | Meaning | Example (12288x8192 image, 2x retina, 1300x800pt viewport) |
| --- | --- | --- |
| `0` | Fit mode (auto-computed) | ~0.195 — whole image fills viewport |
| `0.195` | Equivalent to fit | Image is 1198x799 pt on screen |
| `1.0` | True 100% — pixel-perfect | 1 image pixel = 1 retina pixel. Frame = 6144x4096 pt |
| `2.0` | 200% | Each image pixel = 2x2 retina pixels |
| `8.0` | Maximum zoom (cap) | 800% |

### Why Real Pixels, Not Points?

On a 2x retina display, a points-based "100%" would map 1 image pixel to 1 point = 2 retina pixels — so the image would appear 2x its native size and never look truly sharp. Working in real screen pixels means 100% is always pixel-perfect regardless of the display's scale factor.

---

## Retina Awareness

All rendering accounts for `@Environment(\.displayScale)`:

```swift
// Viewport in real pixels (not points) — what the GPU renders at
editSession.previewSize = CGSize(
    width: geometry.size.width * displayScale,   // e.g. 2600 on 2x retina
    height: geometry.size.height * displayScale   // e.g. 1600
)

// Fit scale: real pixels per image pixel
fitScale = min(viewportPx.width / imageSize.width,
               viewportPx.height / imageSize.height)

// Display frame: convert real-pixel scale back to SwiftUI points
displayW = imageSize.width * pixelScale / displayScale
displayH = imageSize.height * pixelScale / displayScale
```

### Math Walkthrough (12288x8192 image, 2x retina, 1300x800pt viewport)

**Fit mode:**
- viewportPx = 2600x1600
- fitScale = min(2600/12288, 1600/8192) = 0.195
- displayW = 12288 * 0.195 / 2 = 1198 pt — fits in 1300pt viewport
- Render target = 2600x1600 px → bitmap is 2600x1600
- SwiftUI: 2600px bitmap in a 1198pt frame → on 2x retina = 2396 retina pixels ≈ 1:1 — **crisp**

**100% zoom:**
- pixelScale = 1.0
- displayW = 12288 * 1.0 / 2 = 6144 pt — larger than viewport, pannable
- Refine target = nativeImageSize * min(1.0, 1.0) = 12288x8192 → full native render
- SwiftUI: 12288px bitmap in a 6144pt frame → on 2x retina = 12288 retina pixels = **pixel-perfect**

---

## Gesture Handling

### Pinch-to-Zoom

Uses `MagnifyGesture` with a captured start scale to prevent exponential blowup. `MagnifyGesture.value.magnification` is cumulative since the gesture started, so multiplying it into the live `pixelScale` each frame would compound — each frame multiplies on top of an already-multiplied scale.

```swift
@State private var pinchStartScale: CGFloat?

MagnifyGesture()
    .onChanged { value in
        // Capture once at gesture start
        let start = pinchStartScale ?? effectiveScale(viewport: viewport)
        if pinchStartScale == nil { pinchStartScale = start }

        let fit = fitScale(viewport: viewport, imageSize: imageSize)
        pixelScale = clamp(start * value.magnification, fit * 0.5 ... 8.0)
    }
    .onEnded { _ in
        pinchStartScale = nil
        // Snap back to fit if zoomed out past threshold
        if pixelScale <= fitScale * 1.02 {
            pixelScale = 0  // fit mode
            panOffset = .zero
        }
    }
```

### Pan

`DragGesture` with two modes:
- **Zoomed in** (`pixelScale > 0`): drag pans the image within the viewport
- **Fit mode** (`pixelScale == 0`): horizontal swipe navigates to next/previous image (50pt threshold)

### Toolbar Buttons

- **Fit** — sets `pixelScale = 0`, resets pan
- **100%** — sets `pixelScale = 1.0`, resets pan

---

## Viewport Clipping

The image view is wrapped in `.frame(width: viewport, height: viewport).clipped()` so that:

1. The image can be larger than the viewport (zoomed in) and panned via offset
2. Overflow is clipped to the visible area
3. Overlays (zoom indicator, progress spinner) are positioned relative to the fixed viewport frame, not the potentially-huge image frame

Without this, the zoom indicator at `bottomLeading` would be positioned at the bottom-left of the 6144x4096pt image frame — off-screen when zoomed in.

---

## Zoom Indicator

A small badge at the bottom-left shows the current zoom percentage:

```
effectiveScale * 100 = percent
```

- Fit mode on a 12288x8192 image: **~20%**
- Pixel-perfect: **100%**
- Maximum zoom: **800%**

The indicator is always visible regardless of zoom level or rendering state.

---

## Rendering at Zoom

The zoom scale drives the refine pass target size (see [Pipeline](./pipeline.md)):

```
refinedTargetSize = nativeImageSize × min(zoomScale, 1.0)
```

| Zoom | Refine Target | Result |
| --- | --- | --- |
| Fit (0.2) | max(12288*0.2, viewport) = viewport | Same as fast — refine skipped |
| 50% (0.5) | 12288*0.5 = 6144 | Half native — sharper than fast |
| 100% (1.0) | 12288*1.0 = 12288 | Full native — pixel-perfect |
| 200% (2.0) | min(2.0, 1.0) → 12288 | Full native — upscale is display-side only |

Beyond 100%, the render stays at native resolution. The display-side upscale (each image pixel rendered as multiple screen pixels) is handled by SwiftUI's `Image.interpolation(.high)`.
