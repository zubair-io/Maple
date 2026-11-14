package app.justmaple.aperture

import app.justmaple.aperture.data.XmpDocument

/**
 * The slider pair the renderer adopted for one editor generation's name-only imported Auto WB
 * (#4669). It is display state only: the document keeps the name-only request, so the sidecar is
 * never rewritten with numbers.
 */
internal data class ImportedWhiteBalance(val generation: Int, val temperature: Float, val tint: Float)

/** A `crs:WhiteBalance="Auto"` request with neither axis authored, as raw-core resolves it. */
internal val XmpDocument.requestsImportedAutoWhiteBalance: Boolean
    get() =
        attribute("crs:WhiteBalance") == "Auto" &&
            attribute("crs:Temperature") == null &&
            attribute("crs:Tint") == null

/** Shows the adopted pair on a snapshot whose document still carries the name-only request. */
internal fun EditSnapshot.withImportedWhiteBalance(pair: ImportedWhiteBalance): EditSnapshot =
    if (values.isEmpty() || !document.requestsImportedAutoWhiteBalance) this
    else copy(values = values + mapOf("temperature" to pair.temperature, "tint" to pair.tint))
