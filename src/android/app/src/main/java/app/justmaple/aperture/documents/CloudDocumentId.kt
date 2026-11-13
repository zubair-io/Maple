package app.justmaple.aperture.documents

import java.util.Base64

/**
 * Storage Access Framework identity of one Maple Cloud item.
 *
 * `<server>` is a connected server (its library list), `<server>/d/<library>/<slug>/<path>`
 * a folder and `<server>/f/<library>/<slug>/<path>` a file, where `<path>` is the
 * library-relative path as unpadded base64url. IDs are path-keyed like the server's
 * unified listing, so a rename yields a new ID.
 */
internal data class CloudDocumentId(
    val server: String,
    val directory: Boolean,
    val library: String?,
    val slug: String?,
    val path: String,
) {
    val isServerRoot
        get() = library == null

    val isLibraryRoot
        get() = library != null && path.isEmpty()

    val name
        get() = path.substringAfterLast('/')

    val parentPath
        get() = path.substringBeforeLast('/', "")

    val address
        get() = "$slug:$path"

    val extension
        get() = name.substringAfterLast('.', "").lowercase()

    fun encode(): String =
        if (isServerRoot) server
        else "$server/${if (directory) "d" else "f"}/$library/$slug/${encodePath(path)}"

    fun parent(): CloudDocumentId =
        when {
            isServerRoot -> this
            isLibraryRoot -> serverRoot(server)
            else -> folder(server, library!!, slug!!, parentPath)
        }

    fun child(name: String, directory: Boolean): CloudDocumentId {
        check(this.directory && !isServerRoot) { "Only library folders hold documents" }
        requireValidName(name)
        val path = if (path.isEmpty()) name else "$path/$name"
        return CloudDocumentId(server, directory, library, slug, path)
    }

    fun renamed(name: String): CloudDocumentId {
        check(!isServerRoot && !isLibraryRoot) { "Library roots cannot be renamed" }
        requireValidName(name)
        val path = if (parentPath.isEmpty()) name else "$parentPath/$name"
        return copy(path = path)
    }

    /** True when [child] lies strictly inside this document's tree on the same server. */
    fun contains(child: CloudDocumentId): Boolean =
        directory &&
            child != this &&
            child.server == server &&
            when {
                isServerRoot -> true
                child.library != library || child.slug != slug -> false
                path.isEmpty() -> true
                else -> child.path.startsWith("$path/")
            }

    companion object {
        private val SERVER = Regex("[0-9A-Za-z-]{1,64}")
        private val LIBRARY = Regex("[0-9a-f]{24}")
        private val SLUG = Regex("[A-Za-z0-9_-]+")

        fun serverRoot(server: String) = CloudDocumentId(server, true, null, null, "")

        fun folder(server: String, library: String, slug: String, path: String) =
            CloudDocumentId(server, true, library, slug, path)

        fun file(server: String, library: String, slug: String, path: String) =
            CloudDocumentId(server, false, library, slug, path)

        fun parse(value: String): CloudDocumentId {
            val parts = value.split('/')
            require(parts.isNotEmpty() && parts[0].matches(SERVER)) { "Invalid document" }
            if (parts.size == 1) return serverRoot(parts[0])
            require(
                parts.size == 5 &&
                    parts[1] in setOf("d", "f") &&
                    parts[2].matches(LIBRARY) &&
                    parts[3].matches(SLUG)
            ) {
                "Invalid document"
            }
            val path = decodePath(parts[4])
            val directory = parts[1] == "d"
            require(directory || path.isNotEmpty()) { "Invalid document" }
            require(path.isEmpty() || path.split('/').all(::validName)) { "Invalid document" }
            return CloudDocumentId(parts[0], directory, parts[2], parts[3], path)
        }

        /** A server-addressable single path segment that never reaches hidden `.maple/` data. */
        fun validName(name: String): Boolean =
            name.isNotEmpty() &&
                !name.startsWith('.') &&
                '/' !in name &&
                '\\' !in name &&
                '\u0000' !in name &&
                name.toByteArray(Charsets.UTF_8).size <= 255

        fun requireValidName(name: String) =
            require(validName(name)) { "Maple Cloud cannot use the name \"$name\"" }

        private fun encodePath(path: String) =
            Base64.getUrlEncoder().withoutPadding().encodeToString(path.toByteArray(Charsets.UTF_8))

        private fun decodePath(value: String): String =
            try {
                String(Base64.getUrlDecoder().decode(value), Charsets.UTF_8).also {
                    require(encodePath(it) == value)
                }
            } catch (failure: IllegalArgumentException) {
                throw IllegalArgumentException("Invalid document", failure)
            }
    }
}
