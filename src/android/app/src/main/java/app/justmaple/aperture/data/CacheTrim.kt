package app.justmaple.aperture.data

import java.io.File

private val CLOUD_INDEX = Regex("cloud-([0-9a-f]{64})\\.json")
private val CLOUD_PAYLOAD = Regex("cloud-([0-9a-f]{64})-([0-9a-f]{64})\\.avif")

/**
 * Least-recently-used eviction for a private cache folder. A cloud derivative's index and
 * payload are one entry, so neither outlives the other. Callers in the app and the
 * documents provider share one process lock, so publication, open and eviction stay atomic.
 */
internal fun trimCache(folder: File, limit: Long, keep: Set<File>) =
    synchronized(OpenThumbnail.lock) {
        val files =
            folder.listFiles().orEmpty().filter {
                it.isFile && !it.name.endsWith(".tmp") && !it.name.startsWith("thumb-")
            }
        val indexed =
            files
                .mapNotNull { file ->
                    val key =
                        CLOUD_INDEX.matchEntire(file.name)?.groupValues?.get(1)
                            ?: return@mapNotNull null
                    val content = runCatching {
                        org.json.JSONObject(file.readText()).getString("content")
                    }
                        .getOrNull()
                    if (content?.matches(Regex("[0-9a-f]{64}")) == true) key to content
                    else null
                }
                .toMap()
        val entries =
            files
                .groupBy { file ->
                    val index = CLOUD_INDEX.matchEntire(file.name)?.groupValues?.get(1)
                    val payload = CLOUD_PAYLOAD.matchEntire(file.name)
                    when {
                        index != null && index in indexed -> "cloud-$index"
                        payload != null &&
                            indexed[payload.groupValues[1]] == payload.groupValues[2] ->
                            "cloud-${payload.groupValues[1]}"
                        else -> file.name
                    }
                }
                .values
                .sortedByDescending { entry -> entry.maxOf { it.lastModified() } }
        val protected = entries.filter { entry -> entry.any { it in keep } }
        var bytes = protected.sumOf { entry -> entry.sumOf { it.length() } }
        for (entry in entries.filter { group -> group.none { it in keep } }) {
            val size = entry.sumOf { it.length() }
            if (bytes + size <= limit) bytes += size else entry.forEach { it.delete() }
        }
    }
