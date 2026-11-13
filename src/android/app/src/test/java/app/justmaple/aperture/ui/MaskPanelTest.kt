package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskCombine
import app.justmaple.aperture.data.MaskGroup
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.generated.LocalMaskControls
import app.justmaple.aperture.maskLayers
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The real mask panel drives the real ViewModel, undo history and PhotoLibrary
 * sidecar writer; only the JNI renderer (and raw-core's codec behind it) is faked.
 * Every command is exactly one undo entry; selection adds none.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MaskPanelTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var fixture: MaskFixture
    private val model get() = fixture.model

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        fixture = MaskFixture("masks-")
    }

    @After
    fun tearDown() {
        fixture.close()
        Dispatchers.resetMain()
    }

    private fun showPanel() {
        compose.setContent {
            val state by model.state.collectAsState()
            Column(Modifier.size(360.dp, 720.dp).verticalScroll(rememberScrollState())) { MaskPanel(model, state) }
        }
    }

    private fun layers(): List<MaskLayer> = compose.runOnIdle { model.maskLayers() }

    private fun document(): XmpDocument = compose.runOnIdle { model.state.value.document }

    private fun click(tag: String) = compose.onNodeWithTag(tag).performScrollTo().performClick()

    private fun slider(tag: String): SemanticsNodeInteraction =
        compose.onNodeWithTag(tag).performScrollTo().onChildren()
            .filterToOne(SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))

    private fun setSlider(tag: String, value: Float) =
        slider(tag).performSemanticsAction(SemanticsActions.SetProgress) { it(value) }

    /** [action] changes the document by exactly one undo entry. */
    private fun oneEntry(action: () -> Unit) {
        val before = document()
        action()
        val after = document()
        assertNotEquals("The command edits the document", before, after)
        compose.runOnIdle { model.undo() }
        assertEquals("One undo step returns to the document before the command", before, document())
        compose.runOnIdle { model.redo() }
        assertEquals(after, document())
    }

    @Test
    fun everyPanelCommandIsOneUndoEntryAndSelectionIsNone() {
        showPanel()
        compose.onNodeWithTag("editor-mask-empty").assertExists()

        oneEntry { click("editor-mask-add-linear") }
        assertTrue(layers().single().shape is LinearMask)
        oneEntry { click("editor-mask-add-radial") }
        assertTrue(layers()[1].shape is RadialMask)
        compose.runOnIdle { assertEquals(1, model.state.value.maskSelection) }

        // Selecting a row writes nothing and adds no history: undo still removes the radial layer.
        val beforeSelect = document()
        click("editor-mask-row-0")
        compose.onNodeWithTag("editor-mask-row-0").assertIsSelected()
        compose.runOnIdle { assertEquals(0, model.state.value.maskSelection) }
        assertEquals(beforeSelect, document())
        compose.runOnIdle { model.undo() }
        assertEquals(1, layers().size)
        compose.runOnIdle { model.redo() }
        assertEquals(2, layers().size)

        click("editor-mask-row-1")
        oneEntry { click("editor-mask-invert") }
        assertTrue((layers()[1].shape as RadialMask).invert)

        oneEntry {
            slider("editor-mask-feather").performTouchInput {
                down(centerLeft)
                moveBy(androidx.compose.ui.geometry.Offset(width * .2f, 0f))
                moveBy(androidx.compose.ui.geometry.Offset(width * .2f, 0f))
                moveBy(androidx.compose.ui.geometry.Offset(width * .2f, 0f))
                up()
            }
        }
        assertTrue("A feather drag lands away from the default", layers()[1].shape.feather > .55f)

        oneEntry { setSlider("editor-mask-slider-exposure", 1.5f) }
        assertEquals(1.5f, layers()[1].adjustments.getValue("exposure"), 1e-4f)
        oneEntry { setSlider("editor-mask-slider-luminanceNoise", 30f) }
        assertEquals(2, layers()[1].adjustments.size)
        oneEntry { click("editor-mask-reset") }
        assertTrue(layers()[1].adjustments.isEmpty())

        oneEntry { click("editor-mask-range-toggle") }
        assertEquals(LocalMaskControls.defaultRange, layers()[1].range)
        compose.onNodeWithTag("editor-mask-range-hue").assertExists()
        for ((control, value) in LocalMaskControls.range.zip(listOf(20f, .1f, .25f, .75f, .4f))) {
            oneEntry { setSlider("editor-mask-range-slider-${camel(control.name)}", value) }
            assertEquals(value, layers()[1].range!!.getValue(control.name), 1e-4f)
        }
        val range = layers()[1].range

        // Ordered composition: the radial layer becomes a group, then grows.
        oneEntry { click("editor-mask-add-linear-component") }
        oneEntry { click("editor-mask-subtract-radial-component") }
        oneEntry { click("editor-mask-intersect-linear-component") }
        val group = layers()[1].shape as MaskGroup
        assertEquals(
            listOf(MaskCombine.Add, MaskCombine.Add, MaskCombine.Subtract, MaskCombine.Intersect),
            group.components.map { it.combine },
        )
        assertTrue("The radial layer becomes the first component", group.components[0].shape is RadialMask)
        assertTrue((group.components[0].shape as RadialMask).invert)
        assertEquals("The colour range stays on the group", range, layers()[1].range)
        compose.onNodeWithTag("editor-mask-component-3").assertIsSelected()

        val beforeComponentSelect = document()
        click("editor-mask-component-2")
        compose.runOnIdle { assertEquals(2, model.state.value.maskComponent) }
        assertEquals(beforeComponentSelect, document())
        oneEntry { click("editor-mask-component-combine-intersect") }
        assertEquals(MaskCombine.Intersect, (layers()[1].shape as MaskGroup).components[2].combine)
        oneEntry { click("editor-mask-component-delete-1") }
        assertEquals(3, (layers()[1].shape as MaskGroup).components.size)

        oneEntry { click("editor-mask-delete-0") }
        assertEquals(1, layers().size)
        compose.runOnIdle { assertEquals(0, model.state.value.maskSelection) }

        assertTrue(runBlocking { model.flush() })
        val saved = runBlocking { fixture.library.loadSidecar(fixture.photo) }.document
        assertEquals(layers(), model.maskLayers(saved))
        assertTrue(saved.original.contains("<crs:MaskGroupBasedCorrections>"))
    }

    @Test
    fun deletingTheLastLayerReturnsToTheEmptyHint() {
        showPanel()
        click("editor-mask-add-linear")
        compose.onNodeWithTag("editor-mask-row-0").assertIsSelected()
        oneEntry { click("editor-mask-delete-0") }
        compose.onNodeWithTag("editor-mask-empty").assertExists()
        compose.runOnIdle { assertNull(model.state.value.maskSelection) }
        assertFalse(document().serialize().contains("MaskGroupBasedCorrections"))
    }

    @Test
    fun componentEditsReachTheShownComponentAfterUndoingAnAddedOne() {
        showPanel()
        click("editor-mask-add-linear")
        click("editor-mask-add-radial-component")
        click("editor-mask-add-linear-component")
        compose.runOnIdle { model.undo() }
        // The selection still names the third component; the panel shows the second.
        compose.onNodeWithTag("editor-mask-component-1").assertIsSelected()
        oneEntry { click("editor-mask-component-combine-subtract") }
        assertEquals(MaskCombine.Subtract, (layers()[0].shape as MaskGroup).components[1].combine)
        oneEntry { click("editor-mask-component-invert") }
        assertTrue((layers()[0].shape as MaskGroup).components[1].invert)
    }
}
