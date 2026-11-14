package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.addMaskLayer
import app.justmaple.aperture.armMaskPick
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.maskLayers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The overlay crosses ONE presented → frame map, built from the crop and the manual
 * geometry the canvas renders: handles sit at its inverse, a drag and the eyedropper's
 * sample point go through it forward. The fake renderer answers `mask_frame` with a
 * projective map only for the geometry the photo carries, as raw-core's would differ.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MaskOverlayGeometryTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var fixture: MaskFixture
    private val model get() = fixture.model

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        fixture = MaskFixture("mask-overlay-geometry-")
    }

    @After
    fun tearDown() {
        fixture.close()
        Dispatchers.resetMain()
    }

    @Test
    fun anXOffsetMovesHandlesDragsAndTheSamplePoint() =
        assertOverlayMapsThrough(
            sliders = mapOf("perspective_x" to 50f),
            crop = CropRect(),
            // raw-core's map for X = 50: the frame shifted a quarter width (mask_jni_tests).
            projection = doubleArrayOf(1.0, 0.0, -.25, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
        )

    @Test
    fun aKeystoneMapsHandlesDragsAndTheSamplePointProjectively() =
        assertOverlayMapsThrough(
            sliders = mapOf("perspective_vertical" to 40f),
            crop = CropRect(),
            projection = doubleArrayOf(.9, 0.0, -.05, 0.0, .8, .05, 0.0, .4, .8),
        )

    @Test
    fun aGeometryRotationOverACropMapsHandlesDragsAndTheSamplePoint() =
        assertOverlayMapsThrough(
            sliders = mapOf("perspective_rotate" to 10f),
            crop = CropRect(top = .1f, left = .2f, bottom = .9f, right = .7f, angle = 5f),
            projection = doubleArrayOf(.55, -.1, .3, .08, .6, .15, 0.0, 0.0, 1.0),
        )

    private fun assertOverlayMapsThrough(sliders: Map<String, Float>, crop: CropRect, projection: DoubleArray) {
        val renderer = fixture.renderer
        val identity = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        val expectedGeometry = geometryFields.map { sliders[it.name] ?: it.initial }
        renderer.frame = { presented, geometry ->
            if (presented == crop && geometry == expectedGeometry) projection else identity
        }
        compose.runOnIdle {
            sliders.forEach { (name, value) -> model.setField(name, value) }
            if (crop != CropRect()) model.applyCropRect(crop)
            model.addMaskLayer(radial = true)
        }
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(300.dp, 200.dp)) { MaskOverlay(model, state, zoom = 1f) }
        }
        compose.runOnIdle {
            assertEquals("The overlay maps the geometry the canvas renders", crop to expectedGeometry,
                renderer.frameRequests.last())
        }
        val forward = MaskProjection(projection)
        val back = forward.inverse()!!
        val size = overlaySize()

        // The handle sits where the render puts the mask's centre.
        val centre = compose.runOnIdle { (model.maskLayers().single().shape as RadialMask).center }
        val pin = handleAt(MaskHandle.RadialCenter)
        val drawn = back.apply(centre)
        assertEquals(drawn.x * size.x, pin.x, 1.5f)
        assertEquals(drawn.y * size.y, pin.y, 1.5f)

        // The eyedropper samples the frame point under the tap.
        compose.runOnIdle { model.armMaskPick(true) }
        val tap = Offset(size.x * .3f, size.y * .6f)
        compose.onNodeWithTag("editor-mask-overlay").performTouchInput {
            down(tap)
            up()
        }
        val sampled = forward.apply(MaskPoint(.3f, .6f))
        compose.runOnIdle {
            val (x, y) = renderer.samples.single()
            assertEquals(sampled.x, x, 1e-3f)
            assertEquals(sampled.y, y, 1e-3f)
        }

        // A dragged centre lands on the frame point under the finger.
        val delta = Offset(20f, -15f)
        compose.onNodeWithTag("editor-mask-overlay").performTouchInput {
            down(pin)
            moveBy(delta / 2f)
            moveBy(delta / 2f)
            up()
        }
        val target = forward.apply(MaskPoint((pin.x + delta.x) / size.x, (pin.y + delta.y) / size.y))
        val moved = compose.runOnIdle { (model.maskLayers().single().shape as RadialMask).center }
        assertEquals(target.x, moved.x, 1e-3f)
        assertEquals(target.y, moved.y, 1e-3f)
    }

    private fun overlaySize(): Offset =
        compose.onNodeWithTag("editor-mask-overlay").fetchSemanticsNode().boundsInRoot.let {
            Offset(it.width, it.height)
        }

    private fun handleAt(handle: MaskHandle): Offset {
        val overlay = compose.onNodeWithTag("editor-mask-overlay").fetchSemanticsNode().boundsInRoot
        val pin = compose.onNodeWithTag("editor-mask-handle-${handle.id}").fetchSemanticsNode().boundsInRoot
        return pin.center - overlay.topLeft
    }
}
