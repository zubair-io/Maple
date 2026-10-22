package app.justmaple.aperture.ui

import android.app.Application
import android.net.Uri
import android.view.Surface
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.PhotoMode
import app.justmaple.aperture.data.EditorRenderer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.PreviewRenderer
import app.justmaple.aperture.data.XmpDocument
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class CropToolTest {
    @get:Rule val compose = createComposeRule()

    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            emptyMap<String, Float>()
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
        override suspend fun nativeDimensions(photo: app.justmaple.aperture.data.Photo): app.justmaple.aperture.data.NativeImageSize? = null
        override suspend fun nativeDetail(request: app.justmaple.aperture.data.NativeDetailRequest): android.graphics.Bitmap = error("Native detail is not requested by this fixture")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @Test
    fun lockedCornersResizeFromVerticalMotionAndKeepTheOppositeCornerFixed() {
        val original = CropRect(0.2f, 0.3f, 0.8f, 0.7f)
        for (handle in listOf(CropHandle.TL, CropHandle.TR, CropHandle.BL, CropHandle.BR)) {
            val left = handle == CropHandle.TL || handle == CropHandle.BL
            val top = handle == CropHandle.TL || handle == CropHandle.TR
            val next = CropGeometry.resizeCrop(original, handle,
                if (left) original.left else original.right,
                if (top) 0.3f else 0.7f, 1f, 3000f, 2000f)
            assertEquals(0.5f, next.bottom - next.top, 1e-4f)
            assertEquals(1f, 1.5f * (next.right - next.left) / (next.bottom - next.top), 1e-4f)
            assertEquals(if (left) original.right else original.left, if (left) next.right else next.left, 1e-4f)
            assertEquals(if (top) original.bottom else original.top, if (top) next.bottom else next.top, 1e-4f)
        }
    }

    @Test
    fun verticalLockedCornerGestureResizesTheCrop() {
        var crop by mutableStateOf(CropGeometry.centeredCropForAspect(1f, 1.5f, 1f, 0f))
        var commits = 0
        compose.setContent {
            Box(Modifier.size(300.dp, 200.dp)) {
                CropOverlay(crop, { crop = it }, { commits++ }, lockedAspect = 1f, imageAspect = 1.5f)
            }
        }
        compose.onNodeWithTag("crop-overlay").performTouchInput {
            down(Offset(width * crop.right - 1f, height * crop.bottom - 1f))
            moveBy(Offset(0f, -height * 0.1f))
            up()
        }
        compose.runOnIdle {
            assertTrue(crop.bottom < 0.95f)
            assertEquals(1f, 1.5f * (crop.right - crop.left) / (crop.bottom - crop.top), 1e-4f)
            assertEquals(1, commits)
        }
    }

    @Test
    fun cropCatalogMatchesTheNineCanonicalPresets() {
        assertEquals(
            listOf("free", "original", "1:1", "3:2", "4:3", "16:9", "2:3", "3:4", "9:16"),
            CropAspectId.entries.map { it.rawId },
        )
        assertNull(CropAspectId.Free.resolveAspect(3f, 2f))
        assertEquals(1.5f, CropAspectId.Original.resolveAspect(3f, 2f)!!, 0f)
    }

    @Test
    fun cropMoveAccumulatesEventsWithoutWaitingForRecomposition() {
        var result = CropRect(0.2f, 0.2f, 0.8f, 0.8f)
        val original = result
        compose.setContent { Box(Modifier.size(300.dp)) { CropOverlay(original, { result = it }) } }
        compose.onNodeWithTag("crop-overlay").performTouchInput {
            down(center)
            moveBy(Offset(width * 0.025f, 0f))
            moveBy(Offset(width * 0.025f, 0f))
            moveBy(Offset(width * 0.025f, 0f))
            up()
        }
        compose.runOnIdle { assertEquals(0.275f, result.left, 0.002f) }
    }

    @Test
    fun removingTheOverlayCommitsAnInterruptedCropGestureOnce() {
        var shown by mutableStateOf(true)
        var crop by mutableStateOf(CropRect(top = 0.2f, left = 0.2f, bottom = 0.8f, right = 0.8f))
        var commits = 0
        compose.setContent {
            Box(Modifier.size(300.dp)) {
                if (shown) CropOverlay(crop, { crop = it }, { commits++ })
            }
        }
        val overlay = compose.onNodeWithTag("crop-overlay")
        overlay.performTouchInput {
            down(center)
            moveTo(center + Offset(20f, 15f))
        }
        compose.runOnIdle {
            assertFalse(crop.left == 0.2f)
            assertEquals(0, commits)
            shown = false
        }
        compose.runOnIdle { assertEquals(1, commits) }
    }

    @Test
    fun draggingALockedHandlePreservesSquarePixelsOnAWideImage() {
        var crop by mutableStateOf(CropGeometry.centeredCropForAspect(1f, 1.5f, 1f, 0f))
        var commits = 0
        compose.setContent {
            Box(Modifier.size(300.dp, 200.dp)) {
                CropOverlay(crop, { crop = it }, { commits++ }, lockedAspect = 1f, imageAspect = 1.5f)
            }
        }
        compose.onNodeWithTag("crop-overlay").performTouchInput {
            down(Offset(width * crop.right - 1f, height * crop.bottom - 1f))
            moveTo(Offset(width * 0.7f, height * 0.6f))
            up()
        }
        compose.runOnIdle {
            assertEquals(1f, 1.5f * (crop.right - crop.left) / (crop.bottom - crop.top), 1e-4f)
            assertTrue(crop.right < 0.8f)
            assertEquals(1, commits)
        }
    }

    @Test
    fun centeredCropForAspectAndHitTestMatchMapleCoreGeometry() {
        // 3:2 image (3000x2000) cropped to 1:1 square -> left = 1/6, right = 5/6, top = 0, bottom = 1
        val square = CropGeometry.centeredCropForAspect(1f, 3000f, 2000f, angle = 3.5f)
        assertEquals(0f, square.top, 1e-4f)
        assertEquals(1f, square.bottom, 1e-4f)
        assertEquals(1f / 6f, square.left, 1e-4f)
        assertEquals(5f / 6f, square.right, 1e-4f)
        assertEquals(3.5f, square.angle, 1e-4f)

        // Hit-testing corners, edges, and interior move
        assertEquals(
            CropHandle.TL,
            CropGeometry.hitTestHandle(10f, 12f, 0f, 0f, 200f, 100f, 24f),
        )
        assertEquals(
            CropHandle.BR,
            CropGeometry.hitTestHandle(195f, 95f, 0f, 0f, 200f, 100f, 24f),
        )
        assertEquals(
            CropHandle.Move,
            CropGeometry.hitTestHandle(100f, 50f, 0f, 0f, 200f, 100f, 24f),
        )
        assertNull(CropGeometry.hitTestHandle(260f, 50f, 0f, 0f, 200f, 100f, 24f))
    }

    @Test
    fun movingCropMaintainsNormalizedInvariants() {
        val initial = CropRect(top = 0.1f, left = 0.2f, bottom = 0.8f, right = 0.9f, angle = 0f)
        val moved = CropGeometry.moveCrop(initial, dnx = 0.5f, dny = -0.5f)
        assertEquals(0f, moved.top, 1e-4f)
        assertEquals(0.3f, moved.left, 1e-4f)
        assertEquals(0.7f, moved.bottom, 1e-4f)
        assertEquals(1.0f, moved.right, 1e-4f)


    }

    @Test
    fun xmpCropRectRoundTripsCanonicalCrsCropAttributes() {
        val doc =
            XmpDocument()
                .withAttribute("crs:HasCrop", "True")
                .withAttribute("crs:CropTop", "0.125")
                .withAttribute("crs:CropLeft", "0.25")
                .withAttribute("crs:CropBottom", "0.875")
                .withAttribute("crs:CropRight", "0.75")
                .withAttribute("crs:CropAngle", "-2.5")
        val parsed = doc.cropRect()
        assertFalse(parsed.isIdentity)
        assertEquals(0.125f, parsed.top, 1e-4f)
        assertEquals(0.25f, parsed.left, 1e-4f)
        assertEquals(0.875f, parsed.bottom, 1e-4f)
        assertEquals(0.75f, parsed.right, 1e-4f)
        assertEquals(-2.5f, parsed.angle, 1e-4f)
    }

    @Test
    fun cropToolbarAppliesAspectPresetsAndReset() {
        val app: Application = RuntimeEnvironment.getApplication()
        val model = MapleViewModel(app, PhotoLibrary(app), IdleRenderer())
        val photo =
            Photo(
                uri = Uri.parse("content://maple/photo/crop"),
                name = "crop-test.dng",
                size = 1024L,
                modified = 0L,
                parent = null,
            )
        val editedDoc =
            XmpDocument()
                .withAttribute("crs:HasCrop", "True")
                .withAttribute("crs:CropTop", "0.1")
                .withAttribute("crs:CropLeft", "0.1")
                .withAttribute("crs:CropBottom", "0.9")
                .withAttribute("crs:CropRight", "0.9")
        val state =
            MapleState(
                selected = photo,
                photos = listOf(photo),
                mode = PhotoMode.Edit,
                document = editedDoc,
                documentLoaded = true,
                values = mapOf("exposure" to 0f, "_raw" to 1f, "_aspect" to 1.5f),
            )
        compose.setContent {
            Box(Modifier.size(400.dp, 300.dp)) {
                CropControlsSection(model = model, state = state)
            }
        }
        compose.onNodeWithTag("editor-crop-toolbar").assertIsDisplayed()
        compose.onNodeWithTag("editor-crop-aspect-1:1").performClick()
        compose.onNodeWithTag("crop-reset-button").assertIsEnabled()
    }
}
