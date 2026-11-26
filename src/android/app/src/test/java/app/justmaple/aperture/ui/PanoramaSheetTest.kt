package app.justmaple.aperture.ui

import android.os.CancellationSignal
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.cloud.CloudResponse
import app.justmaple.aperture.cloud.CloudTransport
import app.justmaple.aperture.cloud.PanoCapabilities
import app.justmaple.aperture.cloud.PanoConfigState
import app.justmaple.aperture.cloud.PanoFrame
import app.justmaple.aperture.cloud.PanoInputs
import app.justmaple.aperture.cloud.PanoOptions
import app.justmaple.aperture.cloud.PanoPreviewImage
import app.justmaple.aperture.cloud.PanoStitchRun
import app.justmaple.aperture.cloud.PanoramaClient
import app.justmaple.aperture.cloud.PanoramaSession
import app.justmaple.aperture.cloud.PanoramaState
import app.justmaple.aperture.data.LibraryListing
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PanoramaSheetTest {
    @get:Rule val compose = createComposeRule()

    private object Unreachable : CloudTransport {
        override fun request(id: String, path: String, method: String, body: String?, headers: Map<String, String>): CloudResponse =
            error("unused")

        override fun request(
            id: String,
            path: String,
            method: String,
            body: String?,
            headers: Map<String, String>,
            account: String,
        ): CloudResponse = error("unused")

        override fun download(id: String, path: String, output: OutputStream, signal: CancellationSignal?) = error("unused")

        override fun upload(id: String, path: String, file: File, headers: Map<String, String>, account: String): CloudResponse =
            error("unused")
    }

    private val session =
        PanoramaSession(CoroutineScope(Dispatchers.Unconfined), PanoramaClient(Unreachable), { null }, {
            LibraryListing(emptyList(), emptyList())
        })

    private fun show(stitch: PanoStitchRun): MutableList<String> {
        val closes = mutableListOf<String>()
        val state =
            PanoramaState(
                inputs = PanoInputs("s1", "https://photos.example.com#me", listOf("/a.dng", "/b.dng")),
                config = PanoConfigState.Ready(PanoCapabilities(true, true, strategy = true, preview = false, edges = false, seamConstraints = false), "library"),
                stitch = stitch,
            )
        compose.setContent { PanoramaSheet(state, session, onViewResult = {}, onClose = { closes += "close" }) }
        return closes
    }

    @Test
    fun aRunningStitchOffersOnlyCancel() {
        show(PanoStitchRun.Running("s1", null, cancelRequested = false))
        compose.onNodeWithTag("pano-close").assertDoesNotExist()
        compose.onNodeWithTag("pano-cancel").performScrollTo().assertIsEnabled()
    }

    @Test
    fun aCancelTheServerHasNotConfirmedLeavesCloseAvailable() {
        val closes = show(PanoStitchRun.Running("s1", null, cancelRequested = true))
        compose.onNodeWithTag("pano-cancel").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("pano-close").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf("close"), closes)
    }

    @Test
    fun aCancelPressedWhileQueuingLeavesCloseAvailable() {
        val closes = show(PanoStitchRun.Submitting(cancelRequested = true))
        compose.onNodeWithTag("pano-close").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf("close"), closes)
    }

    @Test
    fun aTapThatJittersAddsNoSeamRegionAndADragAsksForOne() {
        val inputs = PanoInputs("s1", "https://photos.example.com#me", listOf("/a.dng", "/b.dng"))
        val options = PanoOptions()
        val frames = listOf(PanoFrame("1".repeat(24), "/a.dng"), PanoFrame("2".repeat(24), "/b.dng"))
        val state =
            PanoramaState(
                inputs = inputs,
                config = PanoConfigState.Ready(PanoCapabilities(true, true, true, true, true, seamConstraints = true), "library"),
                options = options,
                image = PanoPreviewImage("p1", ByteArray(0), 1000, 500, frames, inputs, options, null, null),
            )
        val brush = SeamBrush()
        compose.setContent { Box(Modifier.size(200.dp, 100.dp)) { SeamOverlay(state, session, brush) } }

        compose.onNodeWithTag("pano-seam-canvas").performTouchInput {
            down(center)
            moveBy(Offset(1f, 1f))
            up()
        }
        compose.waitForIdle()
        assertNull(brush.error)

        compose.onNodeWithTag("pano-seam-canvas").performTouchInput {
            swipe(Offset(width * 0.2f, height * 0.2f), Offset(width * 0.6f, height * 0.6f), 200)
        }
        compose.waitForIdle()
        assertNotNull(brush.error)
    }

    @Test
    fun optionChipsAnnounceTheOptionTheyBelongTo() {
        show(PanoStitchRun.Idle)
        compose.onNodeWithContentDescription("Retention: Keep all").assertExists()
        compose.onNodeWithContentDescription("Local alignment: Off").assertExists()
        compose.onNodeWithContentDescription("Projection: Auto").assertExists()
    }
}
