package app.justmaple.aperture.documents

import android.net.Uri
import android.os.CancellationSignal
import app.justmaple.aperture.cloud.CloudHttp
import app.justmaple.aperture.cloud.CloudResponse
import app.justmaple.aperture.cloud.CloudStatusException
import java.io.File
import java.io.OutputStream
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class CloudLibraryRoot(
    val id: String,
    val slug: String,
    val path: String,
    val label: String,
)

internal enum class CloudEntryKind {
    Folder,
    Photo,
    Media,
    File,
    Sidecar,
}

internal data class CloudEntry(
    val path: String,
    val kind: CloudEntryKind,
    val size: Long?,
    val modified: Long?,
    val indexed: Boolean,
) {
    val name
        get() = path.substringAfterLast('/')
}

internal data class CloudChange(
    val cursor: Long,
    val library: String?,
    val relativePath: String?,
    val absolutePath: String?,
)

internal sealed interface CloudChangePage {
    data class Rows(val changes: List<CloudChange>, val next: Long?) : CloudChangePage

    /** The journal no longer holds the cursor: resume from [current] after a full refresh. */
    data class Expired(val current: Long) : CloudChangePage
}

/** The Maple server contract the Apple File Provider also uses, over the app's shared client. */
internal class CloudDocumentsApi(private val http: CloudHttp) {
    fun libraries(server: String): List<CloudLibraryRoot> {
        val list = JSONArray(get(server, "/api/folders", "List libraries").text())
        return (0 until list.length()).mapNotNull { index ->
            val item = list.getJSONObject(index)
            val slug = item.optString("slug")
            val id = item.optString("id")
            if (!slug.matches(SLUG) || !id.matches(LIBRARY)) null
            else
                CloudLibraryRoot(
                    id,
                    slug,
                    item.getString("path"),
                    item.optString("label").ifEmpty { item.getString("path").substringAfterLast('/') },
                )
        }
    }

    fun list(folder: CloudDocumentId): List<CloudEntry> {
        val entries = mutableListOf<CloudEntry>()
        val seen = mutableSetOf<String>()
        var cursor: String? = null
        do {
            val query = "?limit=500" + (cursor?.let { "&cursor=${Uri.encode(it)}" } ?: "")
            val page = JSONObject(get(folder.server, folderPath(folder) + query, "List folder").text())
            entries += page.entries("folders").map { entry(it, CloudEntryKind.Folder) }
            entries +=
                page.entries("images").map { value ->
                    val kind =
                        if (value.optBoolean("isVideo") || value.optBoolean("isAudio") ||
                            value.optBoolean("isStub"))
                            CloudEntryKind.Media
                        else CloudEntryKind.Photo
                    entry(value, kind)
                }
            entries += page.entries("files").map { entry(it, CloudEntryKind.File) }
            entries += page.entries("sidecars").map { entry(it, CloudEntryKind.Sidecar) }
            val next = page.optString("next_cursor").takeIf { it.isNotEmpty() && it != "null" }
            check(next == null || seen.add(next)) { "Cloud folder returned a repeated page cursor" }
            cursor = next
        } while (cursor != null)
        return entries.filter { CloudDocumentId.validName(it.name) }.distinctBy { it.path }
    }

    fun folderExists(folder: CloudDocumentId): Boolean {
        val response = http.request(folder.server, folderPath(folder) + "?limit=1")
        if (response.status == 404) return false
        ensure(response, "Open folder")
        return true
    }

    fun stat(file: CloudDocumentId): CloudEntry? {
        val response =
            http.request(file.server, "/api/folders/${file.library}/file-meta?path=${query(file.path)}")
        if (response.status == 404) return null
        val value = JSONObject(ensure(response, "Read ${file.name}").text())
        return CloudEntry(file.path, kindOf(file.name), value.getLong("size"), time(value), false)
    }

    fun download(file: CloudDocumentId, output: OutputStream, signal: CancellationSignal?) =
        http.download(
            file.server,
            "/api/folders/${file.library}/file?path=${query(file.path)}",
            output,
            signal,
        )

    fun mkdir(folder: CloudDocumentId) =
        ensure(
            http.request(
                folder.server,
                "/api/folders/${folder.library}/mkdir",
                "POST",
                headers = mapOf(TARGET to target(folder.path)),
            ),
            "Create ${folder.name}",
        )

    fun upload(file: CloudDocumentId, data: File): CloudResponse =
        http.upload(
            file.server,
            "/api/folders/${file.library}/upload",
            data,
            mapOf(TARGET to target(file.path), "Content-Type" to "application/octet-stream"),
        )

    fun moveFolder(from: CloudDocumentId, to: CloudDocumentId) =
        ensure(
            http.request(
                from.server,
                "/api/folders/${from.library}/move",
                "POST",
                headers = mapOf("X-Maple-Source-Path" to target(from.path), TARGET to target(to.path)),
            ),
            "Rename ${from.name}",
        )

    /** Moves a non-asset file; answers the asset ID when the path is an indexed photo. */
    fun renameFile(file: CloudDocumentId, name: String): String? {
        val response =
            json(
                file.server,
                "/api/folders/${file.library}/file/relocate",
                JSONObject()
                    .put("source_path", file.path)
                    .put("mode", "move")
                    .put("collision", "skip")
                    .put("destination_path", file.parentPath)
                    .put("destination_filename", name),
            )
        return assetConflict(response) ?: run {
            requireRenamed(ensure(response, "Rename ${file.name}"), name)
            null
        }
    }

    fun assetAt(file: CloudDocumentId): String? {
        val response =
            http.request(file.server, "/api/assets/by-address?address=${query(file.address)}")
        if (response.status == 404) return null
        return JSONObject(ensure(response, "Read ${file.name}").text()).getString("id")
    }

    fun renameAsset(file: CloudDocumentId, asset: String, name: String) {
        val response =
            json(
                file.server,
                "/api/assets/${Uri.encode(asset)}/rename",
                JSONObject()
                    .put("new_filename", name)
                    .put("collision", "skip")
                    .put("source_address", file.address),
            )
        requireRenamed(ensure(response, "Rename ${file.name}"), name)
    }

    /** Intent-carrying trash (#4706): an already-trashed asset is success, never a purge. */
    fun trashAsset(file: CloudDocumentId, asset: String) {
        val response =
            http.request(file.server, "/api/assets/${Uri.encode(asset)}?intent=trash", "DELETE")
        if (response.status == 409 && body(response)?.optString("state") == "trashed") return
        ensure(response, "Delete ${file.name}")
    }

    /** Moves a non-asset file to the library's Maple Trash; answers the asset ID for photos. */
    fun trashFile(file: CloudDocumentId): String? {
        val response =
            http.request(
                file.server,
                "/api/folders/${file.library}/file?path=${query(file.path)}",
                "DELETE",
            )
        return assetConflict(response) ?: run {
            ensure(response, "Delete ${file.name}")
            null
        }
    }

    fun changes(server: String, since: Long, limit: Int): CloudChangePage {
        val response = http.request(server, "/api/changes?since=$since&limit=$limit")
        if (response.status == 409)
            return CloudChangePage.Expired(
                body(response)?.optLong("current", 0L)?.coerceAtLeast(0L) ?: 0L
            )
        val page = JSONObject(ensure(response, "Read changes").text())
        val rows = page.optJSONArray("changes") ?: JSONArray()
        val changes =
            (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                CloudChange(
                    row.getLong("cursor"),
                    row.optNullableString("folder_id"),
                    row.optNullableString("relative_path"),
                    row.optNullableString("abs_path"),
                )
            }
        val next = if (page.isNull("next_cursor")) null else page.optLong("next_cursor")
        return CloudChangePage.Rows(changes, next)
    }

    private fun get(server: String, path: String, action: String) =
        ensure(http.request(server, path), action)

    private fun json(server: String, path: String, body: JSONObject) =
        http.request(
            server,
            path,
            "POST",
            body.toString(),
            mapOf("Content-Type" to "application/json"),
        )

    private fun assetConflict(response: CloudResponse): String? =
        if (response.status != 409) null
        else body(response)?.optString("asset_id")?.takeIf { it.matches(LIBRARY) }

    private fun requireRenamed(response: CloudResponse, name: String) {
        val result = body(response)
        if (result?.optBoolean("skipped") == true)
            throw CloudStatusException(409, "An item named \"$name\" already exists")
    }

    private fun entry(value: JSONObject, kind: CloudEntryKind) =
        CloudEntry(
            value.getString("address").substringAfter(':'),
            kind,
            if (kind == CloudEntryKind.Folder) null else value.optLong("size"),
            time(value),
            value.optBoolean("indexed") && value.has("id"),
        )

    companion object {
        private const val TARGET = "X-Maple-Target-Path"
        private val SLUG = Regex("[A-Za-z0-9_-]+")
        private val LIBRARY = Regex("[0-9a-f]{24}")
        val PHOTO_EXTENSIONS =
            setOf(
                "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2",
                "pef", "srw", "x3f", "3fr", "mef", "erf", "mrw", "raw", "fff", "iiq", "rwl", "kdc",
                "dcr", "mos", "jpg", "jpeg", "png", "webp", "tif", "tiff", "heic", "heif", "avif",
                "psd", "hdr", "exr",
            )
        val MEDIA_EXTENSIONS =
            setOf(
                "mp4", "mov", "m4v", "avi", "mkv", "webm", "3gp", "mts", "m2ts", "mp3", "m4a",
                "wav", "aac", "flac", "ogg",
            )

        /** The listing's classification when only a name is known (create, stat). */
        fun kindOf(name: String): CloudEntryKind =
            when (name.substringAfterLast('.', "").lowercase()) {
                "xmp" -> CloudEntryKind.Sidecar
                in PHOTO_EXTENSIONS -> CloudEntryKind.Photo
                in MEDIA_EXTENSIONS -> CloudEntryKind.Media
                else -> CloudEntryKind.File
            }

        fun ensure(response: CloudResponse, action: String): CloudResponse {
            if (response.status in 200..299) return response
            val detail =
                when (response.status) {
                    401 -> "Maple Cloud session expired. Reconnect this server in Maple."
                    403 -> "Your account does not have file access on this Maple server."
                    else -> body(response)?.optString("error")?.takeIf { it.isNotBlank() }
                        ?: "HTTP ${response.status}"
                }
            throw CloudStatusException(response.status, "$action failed: $detail")
        }

        fun folderPath(folder: CloudDocumentId): String =
            "/api/folder/${folder.slug}" +
                if (folder.path.isEmpty()) "" else "/" + target(folder.path)

        /** Per-segment percent-encoding; the server decodes the whole value once. */
        fun target(path: String): String = path.split('/').joinToString("/") { Uri.encode(it) }

        private fun query(value: String) = Uri.encode(value)

        private fun body(response: CloudResponse): JSONObject? =
            runCatching { JSONObject(response.text()) }.getOrNull()

        private fun time(value: JSONObject): Long? =
            value.optNullableString("mtime")?.let {
                runCatching { Instant.parse(it).toEpochMilli() }.getOrNull()
            }

        private fun JSONObject.entries(key: String): List<JSONObject> {
            val values = optJSONArray(key) ?: return emptyList()
            return (0 until values.length()).map { values.getJSONObject(it) }
        }

        private fun JSONObject.optNullableString(key: String): String? =
            if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
    }
}
