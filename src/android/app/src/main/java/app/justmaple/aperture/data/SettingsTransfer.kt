package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.generated.AdjustmentTransferGroup
import app.justmaple.aperture.generated.AdjustmentTransferMode
import app.justmaple.aperture.ui.fieldLabel

/**
 * Settings copied from one photo. The document is the source sidecar as the
 * serializer writes it, so implied values (profile, white-balance scale) travel
 * explicitly instead of being re-derived from the target's own sidecar.
 */
class CopiedSettings(val sourceName: String, source: XmpDocument) {
    val document = XmpDocument(source.serialize())
}

/** One field whose value a paste changes, in the target's and the source's wire form. */
data class TransferDifference(val field: String, val label: String, val current: String, val incoming: String)

// Android's writer pairs the explicit temperature/tint with this interpretation
// key; a named Lightroom white balance also lives only here.
private const val WHITE_BALANCE_NAME = "crs:WhiteBalance"

/** Fields a paste moves: Unsupported ones never move, nor do RAW-only ones onto a raster. */
fun AdjustmentTransferGroup.transferredFields(raw: Boolean): List<String> =
    fields.filter {
        AdjustmentTransfer.modes.getValue(it) != AdjustmentTransferMode.Unsupported &&
            (raw || it !in AdjustmentFields.rasterRestricted)
    }

private fun attributeKeys(field: String): List<String> =
    AdjustmentTransfer.xmpAttributes[field].orEmpty() +
        if (field == "temperature") listOf(WHITE_BALANCE_NAME) else emptyList()

private fun curveOf(field: String): PointCurve? =
    AdjustmentTransfer.xmpElements[field]?.let(PointCurve.byElement::getValue)

/**
 * Absolute copy of the selected groups' wire values. A key the source omits is
 * removed from the target, so the target renders the source's value; every other
 * attribute and element, foreign bytes included, stays as the target had it.
 */
fun XmpDocument.pasting(
    copied: CopiedSettings,
    groups: Collection<AdjustmentTransferGroup>,
    raw: Boolean,
): XmpDocument =
    groups.flatMap { it.transferredFields(raw) }.fold(this) { target, field ->
        val scalars =
            attributeKeys(field).fold(target) { doc, key ->
                val incoming = copied.document.attribute(key)
                if (doc.attribute(key) == incoming) doc else doc.withAttribute(key, incoming)
            }
        curveOf(field)?.let { scalars.withCurve(it, copied.document.curve(it)) } ?: scalars
    }

/**
 * What pasting [group] changes on [target], field by field, in presentation order.
 * Both sides are compared as written, so a value the serializer implies (the Auto
 * profile) is not reported as a change.
 */
fun transferDifferences(
    target: XmpDocument,
    copied: CopiedSettings,
    group: AdjustmentTransferGroup,
    raw: Boolean,
): List<TransferDifference> {
    val before = XmpDocument(target.serialize())
    val after = XmpDocument(target.pasting(copied, listOf(group), raw).serialize())
    return group.transferredFields(raw).mapNotNull { field ->
        val curve = curveOf(field)
        val changed =
            if (curve != null) before.curve(curve) != after.curve(curve)
            else attributeKeys(field).any { before.attribute(it) != after.attribute(it) }
        if (changed) TransferDifference(field, transferLabel(field), describe(before, field), describe(after, field))
        else null
    }
}

private fun describe(document: XmpDocument, field: String): String {
    curveOf(field)?.let { curve ->
        val knots = document.curve(curve)
        return if (knots.isEmpty()) "Linear"
        else knots.joinToString("  ") { "${XmpDocument.format(it.x * 255f)},${XmpDocument.format(it.y * 255f)}" }
    }
    val keys = AdjustmentTransfer.xmpAttributes[field].orEmpty()
    val present = keys.mapNotNull { key -> document.attribute(key)?.let { key.substringAfter(':') to it } }
    return when {
        field == "temperature" || field == "tint" ->
            present.singleOrNull()?.second
                ?: document.attribute(WHITE_BALANCE_NAME)?.takeUnless { it == "Custom" }
                ?: "As Shot"
        present.isEmpty() -> AdjustmentFields.byName[field]?.initial?.let(XmpDocument::format) ?: "Default"
        keys.size == 1 -> present.single().second
        else -> present.joinToString("  ") { (name, value) -> "$name $value" }
    }
}

private fun transferLabel(field: String): String =
    AdjustmentFields.byName[field]?.let(::fieldLabel)
        ?: field.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
