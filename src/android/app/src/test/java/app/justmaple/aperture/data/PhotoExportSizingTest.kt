package app.justmaple.aperture.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import app.justmaple.aperture.ui.ExportFormat
import app.justmaple.aperture.ui.ExportOptions
import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoExportSizingTest {
    @Test
    fun anExportReachesItsSelectedEdgeWithoutUndersamplingOrUpscaling() {
        val context = RuntimeEnvironment.getApplication()
        val export = PhotoExport(context, PhotoLibrary(context))
        for (width in listOf(3000, 6000, 8191, 11648)) {
            val file = File.createTempFile("maple-export-sizing", ".png", context.cacheDir)
            val bitmap = Bitmap.createBitmap(width, 32, Bitmap.Config.ARGB_8888)
            try {
                file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                val output = ByteArrayOutputStream()
                export.publishRender(file, output, ExportOptions(format = ExportFormat.PNG, maxEdge = 4096))
                val bytes = output.toByteArray()
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                assertEquals("source width $width", minOf(width, 4096), bounds.outWidth)
            } finally {
                bitmap.recycle()
                file.delete()
            }
        }
    }
}
