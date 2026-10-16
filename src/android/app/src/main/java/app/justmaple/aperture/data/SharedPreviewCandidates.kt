package app.justmaple.aperture.data

import android.content.Context
import app.justmaple.aperture.generated.AdjustmentFields
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
        documents
            .find(entries, tier.filename(source.photo.name))
            ?.takeIf { it.modified > source.modified }
            ?.let { SharedCacheCandidate(it, "avif") }
    if (tier == SharedCacheTier.Thumbnail) return listOfNotNull(canonical)
    val stem = "${source.photo.name}.v${AdjustmentFields.pipelineOutputVersion}"
    val descriptor =
        documents.find(entries, "$stem.preview.json") ?: return listOfNotNull(canonical)
    val hosted = runCatching {
        require(descriptor.size in 1..65536)
        val bytes =
            context.contentResolver.openInputStream(descriptor.uri)!!.use { input ->
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
        val json = JSONObject(bytes.toString(Charsets.UTF_8))
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
        val identity = json.getJSONObject("source")
        require(
            exactNumber(identity.get("size"), source.photo.size) &&
                exactNumber(identity.get("lastModified"), source.photo.modified)
        )
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
    return if (
        hosted != null &&
            (canonical == null || hosted.document.modified >= canonical.document.modified)
    )
        listOfNotNull(hosted, canonical).distinct()
    else listOfNotNull(canonical, hosted).distinct()
}

private fun exactNumber(value: Any, expected: Long) =
    value is Number && value.toDouble() == expected.toDouble()
