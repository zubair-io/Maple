package app.justmaple.aperture

import android.content.ContentValues
import android.provider.MediaStore
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue

internal fun AndroidComposeTestRule<*, MainActivity>.captureWalkthrough(name: String) {
    waitForIdle()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.waitForIdle(350, 5_000)
    val context = instrumentation.targetContext
    val size = context.resources.configuration
    val display = "${size.screenWidthDp}x${size.screenHeightDp}"
    val values =
        ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, "$display-$name-${System.nanoTime()}.png")
            put(MediaStore.Downloads.MIME_TYPE, "image/png")
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/MapleWalkthrough")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
    val frame = instrumentation.uiAutomation.takeScreenshot()
    try {
        context.contentResolver.openOutputStream(uri)!!.use {
            assertTrue(frame.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
        }
        context.contentResolver.update(
            uri,
            ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
            null,
            null,
        )
    } finally {
        frame.recycle()
    }
}
