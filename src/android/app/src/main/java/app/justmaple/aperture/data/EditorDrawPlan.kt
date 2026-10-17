package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentField

/**
 * What one draw must send to the native model (#4766). Kept free of JNI so the
 * rules are unit-tested: the per-tick path pushes only the fields that changed,
 * but a field push drifts the native model from the XML it was loaded from
 * (temperature/tint force `wb_source = Manual`), so a document restore (undo,
 * redo, reset) must reload the model even when its XML string is identical to
 * the one already loaded — and a white balance that is back at as-shot is
 * expressed by that reload, never by pushing the as-shot pair as fields, which
 * would re-mark it Manual and can sit outside the slider range.
 */
internal object EditorDrawPlan {
    private val whiteBalance = listOf("temperature", "tint")

    fun needsReload(
        xml: String,
        modelXml: String,
        modelStale: Boolean,
        applied: Map<String, Float>,
        next: Map<String, Float>,
    ): Boolean = xml != modelXml || modelStale || (whiteBalanceChanged(applied, next) && atAsShot(next))

    /** Fields to push after any reload, against the values the native model now holds. */
    fun fieldsToApply(
        applied: Map<String, Float>,
        next: Map<String, Float>,
        fields: Iterable<AdjustmentField>,
    ): List<AdjustmentField> {
        val pushWhiteBalance = whiteBalanceChanged(applied, next) && !atAsShot(next)
        return fields.filter { field ->
            val value = next[field.name] ?: return@filter false
            if (field.name in whiteBalance) pushWhiteBalance else applied[field.name] != value
        }
    }

    private fun whiteBalanceChanged(applied: Map<String, Float>, next: Map<String, Float>) =
        whiteBalance.any { applied[it] != next[it] }

    private fun atAsShot(next: Map<String, Float>) =
        next["temperature"] == next["_shot_temperature"] && next["tint"] == next["_shot_tint"]
}
