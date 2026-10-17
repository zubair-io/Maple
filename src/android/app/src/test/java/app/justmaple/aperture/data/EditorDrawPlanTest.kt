package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import org.junit.Assert.*
import org.junit.Test

/** Undo back to the original document must reload the native model (#4766). */
class EditorDrawPlanTest {
    private val original = "<xml original/>"
    private val shot = mapOf("_shot_temperature" to 7400f, "_shot_tint" to 22f)
    private val asShot = shot + mapOf("temperature" to 7400f, "tint" to 22f, "exposure" to 0f)
    private val dragged = asShot + mapOf("temperature" to 4000f)

    @Test
    fun undoToIdenticalXmlAfterAFieldPush_reloadsTheModel() {
        assertTrue(EditorDrawPlan.needsReload(original, original, modelStale = true, dragged, asShot))
    }

    @Test
    fun sliderTickWithUnchangedXml_doesNotReload() {
        val tick = dragged + mapOf("temperature" to 4100f)
        assertFalse(EditorDrawPlan.needsReload(original, original, modelStale = false, dragged, tick))
        assertEquals(listOf("temperature", "tint"),
            EditorDrawPlan.fieldsToApply(dragged, tick, AdjustmentFields.all).map { it.name })
    }

    @Test
    fun whiteBalanceBackAtAsShot_isAReloadNotAFieldPush() {
        // The as-shot pair can sit outside the slider range and its setter
        // would mark the model Manual; the document already says as-shot.
        assertTrue(EditorDrawPlan.needsReload(original, original, modelStale = false, dragged, asShot))
        assertTrue(EditorDrawPlan.fieldsToApply(dragged, asShot, AdjustmentFields.all).isEmpty())
    }

    @Test
    fun otherFieldsStillPushIncrementally() {
        val next = asShot + mapOf("exposure" to 0.5f)
        assertFalse(EditorDrawPlan.needsReload(original, original, modelStale = false, asShot, next))
        assertEquals(listOf("exposure"),
            EditorDrawPlan.fieldsToApply(asShot, next, AdjustmentFields.all).map { it.name })
    }

    @Test
    fun aDifferentDocumentAlwaysReloads() {
        assertTrue(EditorDrawPlan.needsReload("<xml edited/>", original, modelStale = false, asShot, asShot))
    }
}
