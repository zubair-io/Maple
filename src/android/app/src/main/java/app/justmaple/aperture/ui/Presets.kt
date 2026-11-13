package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.generated.AdjustmentFields
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject

const val PRESET_SCHEMA_VERSION = 1

/**
 * Source-specific fields from `NON_COPYABLE_FIELDS` in `raw-core` that must not be captured
 * or applied in user presets (`src/raw-pipeline/raw-core/src/types/adjustment/schema/groups/mod.rs`).
 */
val nonCopyablePresetFields: Set<String> =
    setOf("capture_sharpening_radius", "wb_sample_x", "wb_sample_y", "wb_algorithm_version", "lens_profile")

/**
 * Canonical snake_case string/enum adjustment fields that map to Android-exposed XMP attributes.
 */
val copyablePresetStringFields: Set<String> =
    setOf("black_white", "film_look", "profile", "wb_source")

val allowedWbSources: Set<String> =
    setOf("AsShot", "Auto", "Preset", "Sampled", "Manual")

private fun normalizePresetStringFieldKey(key: String): String =
    when (key) {
        "crs:ConvertToGrayscale" -> "black_white"
        "papp:FilmLook" -> "film_look"
        "papp:Profile" -> "profile"
        "papp:WbSource" -> "wb_source"
        else -> key
    }

private fun normalizePresetStringFieldValue(key: String, raw: String): String =
    when (key) {
        "black_white" ->
            if (raw == "1" || raw.equals("True", ignoreCase = true) || raw.equals("On", ignoreCase = true)) "On"
            else "Off"
        else -> raw
    }

private fun presetStringFieldToXmp(key: String, value: String): Pair<String, String?>? =
    when (key) {
        "black_white" ->
            when (value) {
                "On" -> "crs:ConvertToGrayscale" to "True"
                "Off" -> "crs:ConvertToGrayscale" to null
                else -> null
            }
        "film_look" -> "papp:FilmLook" to value.takeIf { it.isNotEmpty() }
        "profile" ->
            when (value) {
                "Auto", "Neutral" -> "papp:Profile" to value
                else -> null
            }
        "wb_source" ->
            if (value in allowedWbSources) {
                "papp:WbSource" to (if (value == "AsShot") null else value)
            } else null
        else -> null
    }

/**
 * Validates that a user preset ID contains only lowercase hex digits and hyphens (length 1..64),
 * matching `PresetStore.isSafeID` on Apple (`src/apple/Packages/MapleCore/Sources/MapleCore/Editor/PresetStore.swift`).
 */
fun isSafeUserPresetId(id: String): Boolean =
    id.isNotEmpty() &&
        id.length <= 64 &&
        id.all { (it in '0'..'9') || (it in 'a'..'f') || (it in 'A'..'F') || it == '-' }

/**
 * Built-in presets matching Apple's `builtin-presets.json` (#5193).
 */
data class BuiltInPreset(
    val id: String,
    val name: String,
    val fields: Map<String, Float>,
    val attributes: Map<String, String> = emptyMap(),
    val userCreated: Boolean = false,
    val schemaVersion: Int = PRESET_SCHEMA_VERSION,
)

val builtInPresets: List<BuiltInPreset> =
    listOf(
        BuiltInPreset("builtin-flat", "Flat", mapOf("contrast" to -50f)),
        BuiltInPreset("builtin-high-contrast", "High Contrast", mapOf("contrast" to 50f)),
        BuiltInPreset("builtin-monochrome", "Monochrome", mapOf("saturation" to -100f)),
        BuiltInPreset("builtin-no-sharpening", "No Sharpening", mapOf("sharpen_amount" to 0f)),
        BuiltInPreset("builtin-no-color-nr", "No Color NR", mapOf("nr_color" to 0f)),
    )

fun MapleViewModel.applyBuiltInPreset(preset: BuiltInPreset) {
    preset.fields.forEach { (name, value) ->
        if (name in AdjustmentFields.byName && name !in nonCopyablePresetFields) {
            setField(name, value)
        }
    }
    val authoredWbPair =
        preset.fields.entries.any { (k, v) ->
            (k == "temperature" || k == "tint") && v.isFinite()
        }
    val xmpUpdates = buildMap<String, String?> {
        for ((k, v) in preset.attributes) {
            val canonicalKey = normalizePresetStringFieldKey(k)
            val canonicalVal = normalizePresetStringFieldValue(canonicalKey, v)
            val mapped = presetStringFieldToXmp(canonicalKey, canonicalVal)
            if (mapped != null) put(mapped.first, mapped.second)
        }
        val authoredWbSource =
            preset.attributes.entries
                .firstOrNull { normalizePresetStringFieldKey(it.key) == "wb_source" }
                ?.value
                ?.takeIf { it in allowedWbSources }
        if (authoredWbPair || authoredWbSource != null) {
            val resolvedSource = authoredWbSource ?: "Preset"
            put("papp:WbSource", if (resolvedSource == "AsShot") null else resolvedSource)
            put("crs:WhiteBalance", if (resolvedSource == "AsShot") null else "Custom")
            put("papp:WbSampleX", null)
            put("papp:WbSampleY", null)
            put("papp:WbAlgorithmVersion", null)
        }
    }
    if (xmpUpdates.isNotEmpty()) {
        setAttributes(xmpUpdates, commit = false)
    }
    commitGesture()
}

fun encodeUserPresetsJson(presets: List<BuiltInPreset>): String {
    val array = JSONArray()
    for (preset in presets) {
        val fieldsObj = JSONObject()
        for ((k, v) in preset.fields) fieldsObj.put(k, v.toDouble())
        for ((k, v) in preset.attributes) {
            val canonicalKey = normalizePresetStringFieldKey(k)
            fieldsObj.put(canonicalKey, normalizePresetStringFieldValue(canonicalKey, v))
        }
        array.put(
            JSONObject()
                .put("id", preset.id)
                .put("schemaVersion", preset.schemaVersion)
                .put("name", preset.name)
                .put("fields", fieldsObj)
        )
    }
    return array.toString()
}

fun decodeUserPresetsJson(raw: String?): List<BuiltInPreset> {
    if (raw.isNullOrBlank()) return emptyList()
    return runCatching {
        val trimmed = raw.trim()
        val array =
            if (trimmed.startsWith("{")) {
                JSONObject(trimmed).optJSONArray("presets") ?: return@runCatching emptyList()
            } else {
                JSONArray(trimmed)
            }
        buildList {
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                val id = obj.optString("id").takeIf { it.isNotBlank() } ?: continue
                val name = obj.optString("name").takeIf { it.isNotBlank() } ?: continue
                val schemaVersion = obj.optInt("schemaVersion", PRESET_SCHEMA_VERSION)
                val fieldsObj = obj.optJSONObject("fields")
                val fields = mutableMapOf<String, Float>()
                val attributes = mutableMapOf<String, String>()
                if (fieldsObj != null) {
                    val keys = fieldsObj.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        if (key in nonCopyablePresetFields) continue
                        val rawVal = fieldsObj.opt(key)
                        when (rawVal) {
                            is Number -> {
                                val d = rawVal.toDouble()
                                if (d.isFinite()) fields[key] = d.toFloat()
                            }
                            is String -> {
                                val canonicalKey = normalizePresetStringFieldKey(key)
                                attributes[canonicalKey] = normalizePresetStringFieldValue(canonicalKey, rawVal)
                            }
                            is Boolean -> {
                                attributes[key] = rawVal.toString()
                            }
                        }
                    }
                }
                // Legacy fallback for any preset saved with a top-level "attributes" object
                val attrsObj = obj.optJSONObject("attributes")
                if (attrsObj != null) {
                    val attrKeys = attrsObj.keys()
                    while (attrKeys.hasNext()) {
                        val key = attrKeys.next()
                        val v = attrsObj.optString(key).takeIf { it.isNotBlank() } ?: continue
                        val canonicalKey = normalizePresetStringFieldKey(key)
                        attributes[canonicalKey] = normalizePresetStringFieldValue(canonicalKey, v)
                    }
                }
                if (fields.isNotEmpty() || attributes.isNotEmpty()) {
                    add(
                        BuiltInPreset(
                            id = id,
                            name = name,
                            fields = fields,
                            attributes = attributes,
                            userCreated = true,
                            schemaVersion = schemaVersion,
                        )
                    )
                }
            }
        }
    }.getOrDefault(emptyList())
}

fun MapleState.savablePresetFields(): Map<String, Float> {
    val currentValues = this.values
    return buildMap {
        for ((name, value) in currentValues) {
            if (name in nonCopyablePresetFields) continue
            val spec = AdjustmentFields.byName[name] ?: continue
            val baseline =
                when (name) {
                    "temperature" -> currentValues["_shot_temperature"] ?: spec.initial
                    "tint" -> currentValues["_shot_tint"] ?: spec.initial
                    else -> spec.initial
                }
            if (abs(value - baseline) > 1e-4f) {
                put(name, value)
            }
        }
    }
}

fun MapleState.savablePresetAttributes(): Map<String, String> = buildMap {
    val bw = document.attribute("crs:ConvertToGrayscale")
    if (bw == "1" || bw.equals("True", ignoreCase = true)) {
        put("black_white", "On")
    }
    val film = document.attribute("papp:FilmLook").orEmpty()
    if (film.isNotEmpty()) {
        put("film_look", film)
    }
    val profile =
        document.attribute("papp:Profile")
            ?: if (document.attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
    if (profile != "Auto") {
        put("profile", profile)
    }
    val wbSource = document.attribute("papp:WbSource").orEmpty()
    if (wbSource in allowedWbSources && wbSource != "AsShot") {
        put("wb_source", wbSource)
    }
}

fun MapleState.isPresetActive(preset: BuiltInPreset): Boolean {
    val knownFields = preset.fields.filterKeys { it in AdjustmentFields.byName && it !in nonCopyablePresetFields }
    val knownAttrs =
        preset.attributes.entries
            .map { (k, v) ->
                val ck = normalizePresetStringFieldKey(k)
                ck to normalizePresetStringFieldValue(ck, v)
            }
            .filter { (ck, cv) ->
                ck in copyablePresetStringFields && (ck != "wb_source" || cv in allowedWbSources)
            }
    return (knownFields.isNotEmpty() || knownAttrs.isNotEmpty()) &&
        knownFields.all { (name, target) ->
            val current = values[name] ?: return@all false
            abs(current - target) <= 1e-3f
        } &&
        knownAttrs.all { (name, target) ->
            when (name) {
                "black_white" -> {
                    val bw = document.attribute("crs:ConvertToGrayscale")
                    val currentVal = if (bw == "1" || bw.equals("True", ignoreCase = true)) "On" else "Off"
                    currentVal == target
                }
                "film_look" -> document.attribute("papp:FilmLook").orEmpty() == target
                "profile" -> {
                    val activeProfile =
                        document.attribute("papp:Profile")
                            ?: if (document.attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
                    activeProfile == target
                }
                "wb_source" -> {
                    val activeWbSource = document.attribute("papp:WbSource") ?: "AsShot"
                    activeWbSource == target
                }
                else -> false
            }
        }
}

@Composable
internal fun BuiltInPresetsRow(
    model: MapleViewModel,
    state: MapleState,
    modifier: Modifier = Modifier,
) {
    var saveDialogOpen by remember { mutableStateOf(false) }
    var presetName by remember { mutableStateOf("") }
    val savableFields = remember(state.values) { state.savablePresetFields() }
    val savableAttributes = remember(state.document) { state.savablePresetAttributes() }
    val hasSavableEdits = savableFields.isNotEmpty() || savableAttributes.isNotEmpty()
    val allPresets = remember(state.userPresets) { builtInPresets + state.userPresets }

    Column(modifier.fillMaxWidth().testTag("editor-presets-section")) {
        LazyRow(
            Modifier.fillMaxWidth().testTag("editor-presets-row"),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items(allPresets, key = { it.id }) { preset ->
                val active = state.isPresetActive(preset)
                val knownFields =
                    preset.fields.keys.filter {
                        it in AdjustmentFields.byName && it !in nonCopyablePresetFields
                    }
                val knownAttrs =
                    preset.attributes.keys
                        .map(::normalizePresetStringFieldKey)
                        .filter { it in copyablePresetStringFields }
                val supported =
                    (knownFields.isNotEmpty() || knownAttrs.isNotEmpty()) &&
                        knownFields.all {
                            AdjustmentFields.byName[it]?.let(state::supportsField) == true
                        } &&
                        ("profile" !in knownAttrs || state.values["_raw"] != 0f)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(
                        selected = active,
                        onClick = { model.applyBuiltInPreset(preset) },
                        enabled = state.canEdit && supported,
                        label = { Text(preset.name, fontSize = 12.sp) },
                        modifier =
                            Modifier.semantics { contentDescription = "Preset ${preset.name}" }
                                .testTag("preset-chip-${preset.id}"),
                    )
                    if (preset.userCreated) {
                        TextButton(
                            onClick = { model.deleteUserPreset(preset.id) },
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                            modifier =
                                Modifier.semantics {
                                        contentDescription = "Delete preset ${preset.name}"
                                    }
                                    .testTag("delete-preset-${preset.id}"),
                        ) {
                            Text("×", fontSize = 14.sp, color = MapleColors.muted)
                        }
                    }
                }
            }
            item(key = "save-user-preset") {
                AssistChip(
                    onClick = {
                        presetName = "Preset ${state.userPresets.size + 1}"
                        saveDialogOpen = true
                    },
                    enabled = state.canEdit && hasSavableEdits,
                    label = { Text("+ Save Preset", fontSize = 12.sp) },
                    modifier =
                        Modifier.semantics { contentDescription = "Save current edits as preset" }
                            .testTag("save-user-preset-chip"),
                )
            }
        }
    }

    if (saveDialogOpen) {
        AlertDialog(
            onDismissRequest = { saveDialogOpen = false },
            title = { Text("Save User Preset") },
            text = {
                OutlinedTextField(
                    value = presetName,
                    onValueChange = { presetName = it },
                    label = { Text("Preset name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("save-preset-name-input"),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        model.saveUserPreset(presetName)
                        saveDialogOpen = false
                    },
                    enabled = presetName.isNotBlank() && hasSavableEdits,
                    modifier = Modifier.testTag("confirm-save-preset-button"),
                ) {
                    Text("Save")
                }
            },
            dismissButton = {
                TextButton(onClick = { saveDialogOpen = false }) { Text("Cancel") }
            },
        )
    }
}
