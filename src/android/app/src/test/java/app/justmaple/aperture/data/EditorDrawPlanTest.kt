package app.justmaple.aperture.data

import org.junit.Assert.*
import org.junit.Test

/** Undo back to the original document must reload the native model (#4766). */
class EditorDrawPlanTest {
    private val original = "<xml original/>"
    private val asShot = mapOf("temperature" to 7400f, "tint" to 22f, "exposure" to 0f)
    private val dragged = asShot + mapOf("temperature" to 4000f)

    private fun pushed(applied: Map<String, Float>, next: Map<String, Float>): List<String> =
        buildList { EditorDrawPlan.forEachFieldToApply(applied, next) { field, _ -> add(field.name) } }

    @Test
    fun restoreToIdenticalXmlAfterAFieldPush_reloadsTheModel() {
        // invalidateModel() ran once since the last reload.
        assertTrue(EditorDrawPlan.needsReload(original, original, invalidations = 1, reloadedInvalidation = 0))
    }

    @Test
    fun sliderTickWithUnchangedXml_doesNotReload() {
        assertFalse(EditorDrawPlan.needsReload(original, original, invalidations = 1, reloadedInvalidation = 1))
    }

    @Test
    fun aDifferentDocumentAlwaysReloads() {
        assertTrue(EditorDrawPlan.needsReload("<xml edited/>", original, invalidations = 1, reloadedInvalidation = 1))
    }

    @Test
    fun anInvalidationDuringAnOlderDraw_isNotConsumedByIt() {
        // The older draw saw invalidation 1 and reloaded for it; a restore
        // that arrived meanwhile is invalidation 2 and still forces a reload.
        assertTrue(EditorDrawPlan.needsReload(original, original, invalidations = 2, reloadedInvalidation = 1))
    }

    @Test
    fun afterAReloadToAsShot_matchingValuesPushNothing() {
        // The reloaded model reports the as-shot pair; the restored snapshot
        // carries the same floats, so no setter runs and nothing turns Manual.
        assertTrue(pushed(asShot, asShot).isEmpty())
    }

    @Test
    fun whiteBalancePushesBothFieldsFirst_otherFieldsIncrementally() {
        assertEquals(listOf("temperature", "tint"), pushed(asShot, dragged))
        assertEquals(listOf("exposure"), pushed(asShot, asShot + mapOf("exposure" to 0.5f)))
        assertEquals(listOf("temperature", "tint", "exposure"), pushed(asShot, dragged + mapOf("exposure" to 0.5f)))
    }

    @Test
    fun fieldOrderIsComputedOnce() {
        assertSame(EditorDrawPlan.orderedFields, EditorDrawPlan.orderedFields)
        assertEquals(listOf("temperature", "tint"), EditorDrawPlan.orderedFields.take(2).map { it.name })
    }
}
