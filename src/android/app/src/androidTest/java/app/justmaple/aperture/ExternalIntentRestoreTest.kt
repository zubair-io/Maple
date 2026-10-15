package app.justmaple.aperture

import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class ExternalIntentRestoreTest {
    @Test
    fun freshModelsReopenRetainedViewAndSendIntentsWithSavedActivityState() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val resolver = context.contentResolver
        val bytes = instrumentation.context.assets.open("rgb-gradient.png").use { it.readBytes() }
        val uri =
            resolver.insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                ContentValues().apply {
                    put(
                        MediaStore.Images.Media.DISPLAY_NAME,
                        "restore-${java.util.UUID.randomUUID()}.png",
                    )
                    put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/MapleVerification")
                },
            )!!
        resolver.openOutputStream(uri)!!.use { it.write(bytes) }
        try {
            for (action in listOf(Intent.ACTION_VIEW, Intent.ACTION_SEND)) {
                val intent =
                    Intent(context, MainActivity::class.java).setAction(action).apply {
                        addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                        if (action == Intent.ACTION_VIEW) setDataAndType(uri, "image/png")
                        else {
                            type = "image/png"
                            putExtra(Intent.EXTRA_STREAM, uri)
                        }
                    }
                ActivityScenario.launch<MainActivity>(intent).use { scenario ->
                    val before = model(scenario)
                    waitForPhoto(before, uri)
                    scenario.recreate()
                    assertSame(before, model(scenario))
                    // A killed process has no retained ViewModelStore. Clear it
                    // before recreating with saved activity state.
                    scenario.onActivity { it.viewModelStore.clear() }
                    scenario.recreate()
                    val restored = model(scenario)
                    assertNotSame(before, restored)
                    waitForPhoto(restored, uri)
                    assertTrue(restored.initialIntentHandled)
                    assertNull(restored.state.value.error)
                    assertArrayEquals(bytes, resolver.openInputStream(uri)!!.use { it.readBytes() })
                }
            }
        } finally {
            resolver.delete(uri, null, null)
        }
    }

    private fun model(scenario: ActivityScenario<MainActivity>): MapleViewModel {
        val reference = AtomicReference<MapleViewModel>()
        scenario.onActivity { reference.set(ViewModelProvider(it)[MapleViewModel::class.java]) }
        return reference.get()
    }

    private fun waitForPhoto(model: MapleViewModel, uri: android.net.Uri) {
        val deadline = android.os.SystemClock.uptimeMillis() + 30_000
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            if (model.state.value.selected?.uri == uri && !model.state.value.loading) return
            Thread.sleep(50)
        }
        fail("Restored activity did not reopen its external photo")
    }
}
