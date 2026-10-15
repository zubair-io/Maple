package app.justmaple.aperture

import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.generated.AdjustmentField

internal data class EditSnapshot(val values: Map<String, Float>, val document: XmpDocument)

internal fun EditSnapshot.reset(
    fields: List<AdjustmentField>,
    attributes: List<String>,
): EditSnapshot {
    val scalar = values + fields.associate { it.name to it.initial }
    val resetValues =
        if (fields.any { it.name == "temperature" || it.name == "tint" })
            scalar +
                mapOf(
                    "temperature" to values.getValue("_shot_temperature"),
                    "tint" to values.getValue("_shot_tint"),
                )
        else scalar
    val resetDocument =
        attributes.fold(document.resetFields(fields)) { doc, name -> doc.withAttribute(name, null) }
    return EditSnapshot(resetValues, resetDocument)
}

internal class EditHistory {
    private val undo = ArrayDeque<EditSnapshot>()
    private val redo = ArrayDeque<EditSnapshot>()
    private var gesture: EditSnapshot? = null
    val canUndo
        get() = undo.isNotEmpty()

    val canRedo
        get() = redo.isNotEmpty()

    fun begin(current: EditSnapshot) {
        if (gesture == null) gesture = current
    }

    fun commit(current: EditSnapshot) {
        val before = gesture ?: return
        gesture = null
        if (before != current) {
            undo.addLast(before)
            while (undo.size > 32) undo.removeFirst()
            redo.clear()
        }
    }

    fun undo(current: EditSnapshot): EditSnapshot? {
        if (undo.isEmpty()) return null
        redo.addLast(current)
        return undo.removeLast()
    }

    fun redo(current: EditSnapshot): EditSnapshot? {
        if (redo.isEmpty()) return null
        undo.addLast(current)
        return redo.removeLast()
    }

    fun clear() {
        undo.clear()
        redo.clear()
        gesture = null
    }
}
