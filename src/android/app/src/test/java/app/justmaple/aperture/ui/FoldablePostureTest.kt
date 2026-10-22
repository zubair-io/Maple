package app.justmaple.aperture.ui

import android.app.Application
import android.graphics.Rect
import android.net.Uri
import android.view.Surface
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w800dp-h700dp")
class FoldablePostureTest {
    @get:Rule val compose = createComposeRule()

    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            emptyMap<String, Float>()
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @Test
    fun surfaceDuoDualScreenVerticalHingeProducesBookVerticalSplit() {
        // Surface Duo spanned: 2784x1800 px at density 2.5 (1113.6dp x 720dp), 84px hinge in center
        val posture =
            computeFoldablePosture(
                windowWidthPx = 2784,
                windowHeightPx = 1800,
                density = 2.5f,
                smallestScreenWidthDp = 540,
                foldBoundsPx = Rect(1350, 0, 1434, 1800),
                foldOrientationVertical = true,
                foldIsHalfOpened = false,
                foldIsSeparating = true,
            )
        assertEquals(PostureKind.BookVerticalSplit, posture.kind)
        assertTrue(posture.isBookSplit)
        assertTrue(posture.isWideLayout)
        assertEquals(540f, posture.primaryPaneSpanDp.value, 0.5f)
        assertEquals(33.6f, posture.hingeSpanDp.value, 0.5f)
        assertEquals(540f, posture.secondaryPaneSpanDp.value, 0.5f)
    }

    @Test
    fun galaxyZFoldHalfOpenedHorizontalCreaseProducesTabletopSplit() {
        // Galaxy Z Fold unfolded tabletop: 1812x2176 px at density 2.625, horizontal crease at y=1088
        val posture =
            computeFoldablePosture(
                windowWidthPx = 1812,
                windowHeightPx = 2176,
                density = 2.625f,
                smallestScreenWidthDp = 690,
                foldBoundsPx = Rect(0, 1088, 1812, 1088),
                foldOrientationVertical = false,
                foldIsHalfOpened = true,
                foldIsSeparating = true,
            )
        assertEquals(PostureKind.TabletopHorizontalSplit, posture.kind)
        assertTrue(posture.isTabletopSplit)
        assertEquals(414.5f, posture.primaryPaneSpanDp.value, 0.5f)
        assertEquals(0f, posture.hingeSpanDp.value, 0.1f)
        assertEquals(414.5f, posture.secondaryPaneSpanDp.value, 0.5f)
    }

    @Test
    fun unfoldedFlatFoldableAdaptsToWideLayoutWhileLandscapePhoneRemainsCompact() {
        // Unfolded Galaxy Z Fold flat: 673dp x 841dp even if smallestScreenWidthDp was 373 from cover display
        val unfoldedFlat =
            computeFoldablePosture(
                windowWidthPx = 1346,
                windowHeightPx = 1682,
                density = 2.0f,
                smallestScreenWidthDp = 373,
            )
        assertEquals(PostureKind.Normal, unfoldedFlat.kind)
        assertTrue(
            "Unfolded flat foldable must activate wide layout",
            unfoldedFlat.isWideLayout,
        )

        // Regular phone rotated to landscape: 840dp x 390dp (smallestScreenWidthDp = 390)
        val landscapePhone =
            computeFoldablePosture(
                windowWidthPx = 1680,
                windowHeightPx = 780,
                density = 2.0f,
                smallestScreenWidthDp = 390,
            )
        assertFalse(
            "Compact phone in landscape must stay in phone layout",
            landscapePhone.isWideLayout,
        )
    }

    @Test
    fun bookSplitPhotoSurfaceSeparatesCanvasAndInspectorAroundHinge() {
        val app: Application = RuntimeEnvironment.getApplication()
        val model = MapleViewModel(app, PhotoLibrary(app), IdleRenderer())
        val photo =
            Photo(
                uri = Uri.parse("content://maple/photo/1"),
                name = "duo-frame.dng",
                size = 1024L,
                modified = 0L,
                parent = null,
            )
        val state =
            MapleState(
                selected = photo,
                photos = listOf(photo),
                mode = PhotoMode.Edit,
                document = XmpDocument(),
                documentLoaded = true,
                values = mapOf("exposure" to 0f, "_raw" to 1f, "_aspect" to 1.5f),
            )
        val duoPosture =
            FoldablePosture(
                kind = PostureKind.BookVerticalSplit,
                primaryPaneSpanDp = 360.dp,
                hingeSpanDp = 28.dp,
                secondaryPaneSpanDp = 360.dp,
                windowWidthDp = 748.dp,
                windowHeightDp = 540.dp,
                smallestScreenWidthDp = 540,
            )
        compose.setContent {
            Box(Modifier.size(748.dp, 540.dp)) {
                PhotoSurface(
                    model = model,
                    state = state,
                    tablet = true,
                    showInspector = true,
                    onInfo = {},
                    onExport = {},
                    posture = duoPosture,
                )
            }
        }
        compose.onNodeWithTag("foldable-book-surface").assertIsDisplayed()
        val primaryBounds =
            compose.onNodeWithTag("foldable-primary-pane").fetchSemanticsNode().boundsInRoot
        val hingeBounds =
            compose.onNodeWithTag("foldable-hinge-spacer").fetchSemanticsNode().boundsInRoot
        val secondaryBounds =
            compose.onNodeWithTag("foldable-secondary-pane").fetchSemanticsNode().boundsInRoot
        val headerBounds =
            compose.onNodeWithTag("photo-header").fetchSemanticsNode().boundsInRoot
        val inspectorBounds =
            compose.onNodeWithTag("adjustments-panel").fetchSemanticsNode().boundsInRoot

        assertTrue(
            "Primary pane must end at or before hinge start",
            primaryBounds.right <= hingeBounds.left + 1f,
        )
        assertTrue(
            "Secondary pane must start at or after hinge end",
            secondaryBounds.left >= hingeBounds.right - 1f,
        )
        assertTrue(
            "Floating header must stay inside primary pane and out of hinge",
            headerBounds.right <= primaryBounds.right + 1f,
        )
        assertTrue(
            "Adjustments inspector must reside in secondary pane after hinge",
            inspectorBounds.left >= secondaryBounds.left - 1f,
        )
    }

    @Test
    fun tabletopSplitPhotoSurfacePlacesCanvasAboveCreaseAndControlsBelow() {
        val app: Application = RuntimeEnvironment.getApplication()
        val model = MapleViewModel(app, PhotoLibrary(app), IdleRenderer())
        val photo =
            Photo(
                uri = Uri.parse("content://maple/photo/2"),
                name = "fold-tabletop.dng",
                size = 1024L,
                modified = 0L,
                parent = null,
            )
        val state =
            MapleState(
                selected = photo,
                photos = listOf(photo),
                mode = PhotoMode.Edit,
                document = XmpDocument(),
                documentLoaded = true,
                values = mapOf("exposure" to 0f, "_raw" to 1f, "_aspect" to 1.5f),
            )
        val tabletopPosture =
            FoldablePosture(
                kind = PostureKind.TabletopHorizontalSplit,
                primaryPaneSpanDp = 320.dp,
                hingeSpanDp = 8.dp,
                secondaryPaneSpanDp = 320.dp,
                windowWidthDp = 680.dp,
                windowHeightDp = 648.dp,
                smallestScreenWidthDp = 680,
            )
        compose.setContent {
            Box(Modifier.size(680.dp, 648.dp)) {
                PhotoSurface(
                    model = model,
                    state = state,
                    tablet = true,
                    showInspector = true,
                    onInfo = {},
                    onExport = {},
                    posture = tabletopPosture,
                )
            }
        }
        compose.onNodeWithTag("foldable-tabletop-surface").assertIsDisplayed()
        val topBounds =
            compose.onNodeWithTag("tabletop-top-pane").fetchSemanticsNode().boundsInRoot
        val hingeBounds =
            compose.onNodeWithTag("tabletop-hinge-spacer").fetchSemanticsNode().boundsInRoot
        val bottomBounds =
            compose.onNodeWithTag("tabletop-bottom-pane").fetchSemanticsNode().boundsInRoot

        assertTrue("Top pane must end above horizontal crease", topBounds.bottom <= hingeBounds.top + 1f)
        assertTrue("Bottom pane must start below horizontal crease", bottomBounds.top >= hingeBounds.bottom - 1f)
    }
}
