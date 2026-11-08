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
}
