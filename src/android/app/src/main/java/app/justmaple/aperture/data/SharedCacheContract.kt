package app.justmaple.aperture.data

/** Mirrors the API/Apple fixed tiers; cross-language contract tests pin these values. */
internal enum class SharedCacheTier(val directory: String, val edge: Int, val quality: Int) {
    Thumbnail("thumbs", 512, 55),
    Preview("previews", 1280, 70);

    fun filename(name: String): String {
        require(validBasename(name))
        return "$name.avif"
    }

    /** The last versioned name ever written; readers rename it into place on a miss (#4793). */
    fun legacyFilename(name: String): String {
        require(validBasename(name))
        val stem = if (this == Thumbnail) PhotoLibrary.digest(name).take(16) else name
        return "$stem.v$LEGACY_VERSION.avif"
    }

    companion object {
        private const val LEGACY_VERSION = 25

        fun forEdge(edge: Int) = if (edge <= 512) Thumbnail else Preview

        fun validBasename(name: String) =
            name.isNotEmpty() && name != "." && name != ".." && '/' !in name && '\\' !in name
    }
}

internal data class FolderCacheSource(
    val photo: Photo,
    val xml: String?,
    val sidecar: LocalDocument?,
) {
    val modified
        get() = maxOf(photo.modified, sidecar?.modified ?: 0)

    val canShare
        get() =
            SharedCacheTier.validBasename(photo.name) &&
                photo.contentDigest == null &&
                photo.size > 0 &&
                photo.modified > 0 &&
                (sidecar == null || sidecar.modified > 0)

    val identity
        get() = PhotoLibrary.digestParts(photo.key, ":", xml.orEmpty())
}
