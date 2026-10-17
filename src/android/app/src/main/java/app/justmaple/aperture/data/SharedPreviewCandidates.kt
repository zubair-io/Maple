package app.justmaple.aperture.data

import android.content.Context
import java.io.ByteArrayOutputStream
import org.json.JSONObject

internal data class SharedCacheCandidate(val document: LocalDocument, val format: String)

/** Hosted's descriptor declares its JPEG/WebP/PNG fallback; newer canonical AVIF wins. */
internal fun sharedPreviewCandidates(
    context: Context,
    documents: CacheDocuments,
    source: FolderCacheSource,
    tier: SharedCacheTier,
    entries: List<LocalDocument>,
): List<SharedCacheCandidate> {
    val canonical =
        (documents.find(entries, tier.filename(source.photo.name))
                // Only reached when the provider refused the legacy rename (read-only folders).
                ?: documents.find(entries, tier.legacyFilename(source.photo.name)))
            ?.takeIf { it.modified > source.modified }
            ?.let { SharedCacheCandidate(it, "avif") }
    if (tier == SharedCacheTier.Thumbnail) return listOfNotNull(canonical)
    val stem = source.photo.name
    val descriptors = entries.filter { it.name == "$stem.preview.json" }
    if (descriptors.isEmpty()) {
        val receipts = entries.filter { it.name == "$stem.avif.source.json" }
        if (receipts.isEmpty()) return listOfNotNull(canonical)
        val receipt = receipts.singleOrNull()?.takeIf { !it.directory } ?: return emptyList()
        val valid = runCatching {
            sameSource(readCacheJson(context, receipt), source)
        }
            .getOrDefault(false)
        return if (valid) listOfNotNull(canonical) else emptyList()
    }
    val descriptor = descriptors.singleOrNull()?.takeIf { !it.directory } ?: return emptyList()
    val hosted = runCatching {
        val json = readCacheJson(context, descriptor)
        require(exactNumber(json.get("version"), 1))
        val format = json.getString("format")
        val (extension, mime) =
            when (format) {
                "avif" -> "avif" to "image/avif"
                "jpeg" -> "jpg" to "image/jpeg"
                "webp" -> "webp" to "image/webp"
                "png" -> "png" to "image/png"
                else -> error("Unsupported shared preview format")
            }
        require(json.getString("mimeType") == mime)
        require(sameSource(json.getJSONObject("source"), source))
        val artifact =
            documents.find(entries, "$stem.$extension") ?: error("Missing shared preview")
        require(
            artifact.modified > 0 &&
                artifact.modified > source.modified &&
                exactNumber(json.get("artifactLastModified"), artifact.modified)
        )
        SharedCacheCandidate(artifact, format)
    }
        .getOrNull()
    if (hosted == null) return emptyList()
    return if (
        hosted.format != "avif" &&
            canonical != null &&
            canonical.document.modified > hosted.document.modified
    )
        listOf(canonical, hosted)
    else listOf(hosted)
}

private fun sameSource(identity: JSONObject, source: FolderCacheSource) =
    exactNumber(identity.get("size"), source.photo.size) &&
        exactNumber(identity.get("lastModified"), source.photo.modified)

private fun readCacheJson(context: Context, document: LocalDocument): JSONObject {
    require(document.size in 1..65536)
    val bytes =
        context.contentResolver.openInputStream(document.uri)!!.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= 65536)
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
    return JSONObject(bytes.toString(Charsets.UTF_8))
}

private fun exactNumber(value: Any, expected: Long) =
    value is Number && value.toDouble() == expected.toDouble()
