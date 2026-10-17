package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.AdjustmentFields

/**
 * What one draw must send to the native model (#4766). Kept free of JNI so the
 * rules are unit-tested: the per-tick path pushes only the fields that changed,
 * but a field push drifts the native model from the XML it was loaded from
 * (temperature/tint force `wb_source = Manual`), so a document restore (undo,
 * redo, reset) must reload the model even when its XML string is identical to
 * the one already loaded. Invalidations are counted rather than flagged, so a
 * draw that was already running when a restore arrived cannot consume it.
 * Nothing here allocates per call: the field order is computed once and the
 * walk is a plain loop.
 */
internal object EditorDrawPlan {
    /** White balance first: its setter marks the model Manual, which later fields must not undo. */
    val orderedFields: List<AdjustmentField> =
        AdjustmentFields.all.sortedBy { it.name != "temperature" && it.name != "tint" }

    fun needsReload(xml: String, modelXml: String, invalidations: Int, reloadedInvalidation: Int): Boolean =
        xml != modelXml || invalidations != reloadedInvalidation

    /** Visits the fields to push after any reload, against the values the native model now holds. */
    inline fun forEachFieldToApply(
        applied: Map<String, Float>,
        next: Map<String, Float>,
        push: (AdjustmentField, Float) -> Unit,
    ) {
        val pushWhiteBalance = applied["temperature"] != next["temperature"] || applied["tint"] != next["tint"]
        for (field in orderedFields) {
            val value = next[field.name] ?: continue
            val whiteBalance = field.name == "temperature" || field.name == "tint"
            if (if (whiteBalance) pushWhiteBalance else applied[field.name] != value) push(field, value)
        }
    }
}
