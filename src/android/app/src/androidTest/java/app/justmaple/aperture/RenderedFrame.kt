package app.justmaple.aperture

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*

/** Read the actual native canvas buffer, independently of floating UI overlays. */
internal fun renderedPixel(activity: MainActivity): Int {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    fun find(view: View): SurfaceView? {
        if (view is SurfaceView) return view
        if (view is ViewGroup)
            for (index in 0 until view.childCount) find(view.getChildAt(index))?.let {
                return it
            }
        return null
    }
    val ready = CountDownLatch(1)
    val bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    var result = PixelCopy.ERROR_SOURCE_NO_DATA
    instrumentation.runOnMainSync {
        val view = find(activity.window.decorView) ?: error("No native photo canvas")
        val x = view.width / 2
        val y = view.height / 2
        PixelCopy.request(
            view,
            Rect(x, y, x + 1, y + 1),
            bitmap,
            {
                result = it
                ready.countDown()
            },
            Handler(Looper.getMainLooper()),
        )
    }
    assertTrue("Native frame read timed out", ready.await(10, TimeUnit.SECONDS))
    return try {
        assertEquals(PixelCopy.SUCCESS, result)
        bitmap.getPixel(0, 0)
    } finally {
        bitmap.recycle()
    }
}
