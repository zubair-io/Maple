package app.justmaple.aperture.data

import org.json.JSONObject

/** The local-adjustment containers raw-core reads; Android hands all four to the native writer. */
internal val MASK_CONTAINERS =
    setOf(
        "crs:GradientBasedCorrections",
        "crs:CircularGradientBasedCorrections",
        "papp:BrushCorrections",
        "crs:MaskGroupBasedCorrections",
    )

/**
 * Mask containers rewritten by `mask_write.rs`: [containers] replaces the source
 * document's container at each index (`""` removes it) and [appended] are new
 * containers written as the last children of the last primary description.
 */
data class MaskEdit(val containers: List<String>, val appended: List<String>)

/** One container's source text and the namespaces in force where it sits. */
internal fun maskSource(scope: Map<String, String>, xml: String): JSONObject =
    JSONObject().put("scope", JSONObject(scope)).put("xml", xml)
