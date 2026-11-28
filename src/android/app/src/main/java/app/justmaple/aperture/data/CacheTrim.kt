package app.justmaple.aperture.data

import java.io.File

private val CLOUD_INDEX = Regex("cloud-([0-9a-f]{64})\\.json")
private val CLOUD_PAYLOAD = Regex("cloud-([0-9a-f]{64})-([0-9a-f]{64})\\.avif")
private val CLOUD_PNG = Regex("png-cloud-([0-9a-f]{64})-([0-9a-f]{64})\\.png")
private const val EVICTION_TARGET_PERCENT = 90

/** Least-recently-used eviction down to [EVICTION_TARGET_PERCENT] of the limit; a cloud derivative's index, payload and PNG go together. */
internal fun trimCache(folder: File, limit: Long, keep: Set<File>) =
    synchronized(OpenThumbnail.lock) {
        val files =
            folder.listFiles().orEmpty().filter {
                it.isFile && !it.name.endsWith(".tmp") && !it.name.startsWith("thumb-")
            }
        if (files.sumOf { it.length() } <= limit) return@synchronized
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
                    val payload = CLOUD_PAYLOAD.matchEntire(file.name) ?: CLOUD_PNG.matchEntire(file.name)
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
        val target = limit * EVICTION_TARGET_PERCENT / 100
        var bytes = protected.sumOf { entry -> entry.sumOf { it.length() } }
        for (entry in entries.filter { group -> group.none { it in keep } }) {
            val size = entry.sumOf { it.length() }
            if (bytes + size <= target) bytes += size else entry.forEach { it.delete() }
        }
    }
