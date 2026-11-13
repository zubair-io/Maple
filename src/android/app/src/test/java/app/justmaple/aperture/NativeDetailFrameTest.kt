package app.justmaple.aperture

import android.graphics.Bitmap
import app.justmaple.aperture.data.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativeDetailFrameTest {
    @Test fun pixelsRetireOnlyAfterPublicationAndEveryComposedReaderReleaseThem() {
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        val frame = NativeDetailFrame("photo", XmpDocument(), NativeRegion(0, 0, 8, 8), bitmap)
        val first = frame.retain()!!
        val second = frame.retain()!!
        frame.close()
        frame.close()
        assertFalse(bitmap.isRecycled)
        first.close()
        first.close()
        assertFalse(bitmap.isRecycled)
        second.close()
        assertTrue(bitmap.isRecycled)
        assertNull(frame.retain())
    }
}
