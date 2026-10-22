package app.justmaple.aperture.ui

import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.data.NativeRegion
import app.justmaple.aperture.data.nativeViewportRegion
import org.junit.Assert.*
import org.junit.Test

class NativeViewportGeometryTest {
    @Test fun sourceWindowUsesActualPixelsAndClampsAtEveryEdge() {
        val size = NativeImageSize(6000, 4000)
        assertEquals(NativeRegion(2500, 1625, 1000, 750),
            nativeViewportRegion(size, 1000f, 750f, 1f, 0f, 0f))
        assertEquals(NativeRegion(2750, 1812, 500, 376),
            nativeViewportRegion(size, 1000f, 750f, 2f, 0f, 0f))
        assertEquals(NativeRegion(0, 0, 1000, 750),
            nativeViewportRegion(size, 1000f, 750f, 1f, 2500f, 1625f))
        assertEquals(NativeRegion(5000, 3250, 1000, 750),
            nativeViewportRegion(size, 1000f, 750f, 1f, -2500f, -1625f))
        assertNull(nativeViewportRegion(size, 1000f, 750f, .5f, 0f, 0f))
        assertNull(nativeViewportRegion(size, 1000f, 750f, Float.NaN, 0f, 0f))
    }

    @Test fun panningMarginContainsTheViewportWithoutLeavingTheImage() {
        val size = NativeImageSize(6000, 4000)
        for (region in listOf(NativeRegion(2500, 1625, 1000, 750),
            NativeRegion(0, 0, 1000, 750), NativeRegion(5000, 3250, 1000, 750))) {
            val padded = region.withPanMargin(size)
            assertTrue(padded.contains(region))
            assertTrue(padded.x >= 0 && padded.y >= 0)
            assertTrue(padded.x + padded.width <= size.width)
            assertTrue(padded.y + padded.height <= size.height)
        }
    }

    @Test fun delayedOriginalMetadataKeepsOneToOneDoubleTapAndItsAnchor() {
        val zoom = CanvasZoomState()
        zoom.doubleTap(750f, 375f, 2048, 1365, 1000f, 750f)
        zoom.adoptNativeDimensions(2048, 1365, 6000, 4000, 1000f, 750f)
        assertEquals(1f, zoom.pixelScale, 0f)
        assertEquals(-1250f, zoom.panX, .001f)
        assertEquals(4500f, (750f - 500f - zoom.panX) / zoom.pixelScale + 3000f, .001f)
    }

    @Test fun delayedOriginalMetadataKeepsPinchMagnificationRelativeToFit() {
        val zoom = CanvasZoomState()
        zoom.applyPinch(2f, 750f, 375f, 2048, 1365, 1000f, 750f)
        zoom.adoptNativeDimensions(2048, 1365, 6000, 4000, 1000f, 750f)
        assertEquals(2f, zoom.zoomFactorOverFit(6000, 4000, 1000f, 750f), .001f)
        assertEquals(-250f, zoom.panX, .001f)
    }
}
