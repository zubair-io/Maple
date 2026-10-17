package app.justmaple.aperture.cloud

import android.content.Context
import android.net.Uri
import app.justmaple.aperture.data.*
import java.io.OutputStream
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal class CloudDerivativePending(val retryMillis: Long) : Exception("Cloud photo is indexing")

class CloudLibrary(context: Context) {
    private val credentials = CloudCredentials(context)
    private val http = CloudHttp(credentials)
    private val signIn = CloudSignIn(credentials)
    val signingIn: Boolean
        get() = signIn.pending

    val sources: List<Folder>
        get() = credentials.servers().map(::source)

    fun begin(input: String): Uri = signIn.begin(input)

    fun cancelLogin() = signIn.cancel()

    suspend fun complete(callback: Uri): Folder = source(signIn.complete(callback))

    suspend fun pollSignIn(): Folder? = signIn.poll()?.let(::source)

    private fun source(server: CloudServer) =
        Folder(root(server.id), Uri.parse(server.origin).authority ?: server.origin)

    suspend fun disconnect(folder: Folder): Unit =
        withContext(Dispatchers.IO) {
            val id = folder.uri.host ?: error("Invalid server")
            http.disconnect(id)
        }

    suspend fun list(uri: Uri): LibraryListing {
        val id = uri.host ?: error("Invalid cloud source")
        if (uri.getQueryParameter("address") == null) {
            val libraries = JSONArray(http.request(id, "/api/folders").requireSuccess().text())
            return LibraryListing(
                (0 until libraries.length()).mapNotNull { index ->
                    val item = libraries.getJSONObject(index)
                    val slug = item.optString("slug")
                    if (slug.isEmpty()) null
                    else
                        Folder(
                            address(id, "$slug:", item.getString("path")),
                            item.optString("label").ifEmpty {
                                item.getString("path").substringAfterLast('/')
                            },
                        )
                },
                emptyList(),
            )
        }
        fun entry(value: JSONObject): Uri =
            address(id, value.getString("address"), value.getString("path"))
        fun entries(page: JSONObject, key: String): List<JSONObject> {
            val values = page.getJSONArray(key)
            return (0 until values.length()).map { values.getJSONObject(it) }
        }
        val folders = mutableListOf<Folder>()
        val photos = mutableListOf<Photo>()
        val seen = mutableSetOf<String>()
        var parent: Folder? = null
        var cursor: String? = null
        do {
            currentCoroutineContext().ensureActive()
            val query = "?limit=500" + (cursor?.let { "&cursor=${Uri.encode(it)}" } ?: "")
            val page =
                JSONObject(
                    http.request(id, mediaPath("folder", uri) + query).requireSuccess().text()
                )
            if (parent == null) {
                val parentAddress =
                    page.optString("parent").takeIf { it.isNotEmpty() && it != "null" }
                parent =
                    Folder(
                        if (parentAddress != null)
                            address(id, parentAddress, page.getString("parentPath"))
                        else root(id),
                        "..",
                    )
            }
            folders +=
                entries(page, "folders").map { value ->
                    Folder(entry(value), value.getString("name"))
                }
            photos +=
                entries(page, "images")
                    .filter { value ->
                        value.getString("name").substringAfterLast('.', "").lowercase() in
                            PhotoLibrary.EXTENSIONS
                    }
                    .map { value ->
                        Photo(
                            entry(value),
                            value.getString("name"),
                            value.getLong("size"),
                            Instant.parse(value.getString("mtime")).toEpochMilli(),
                            uri,
                        )
                    }
            // Discard the page's ordinary files/sidecars before requesting another.
            val next = page.optString("next_cursor").takeIf { it.isNotEmpty() && it != "null" }
            check(next == null || seen.add(next)) { "Cloud folder returned a repeated page cursor" }
            cursor = next
        } while (cursor != null)
        return LibraryListing(
            listOfNotNull(parent) + folders.distinctBy { it.uri },
            photos.distinctBy { it.uri },
        )
    }

    fun copyOriginal(photo: Photo, output: OutputStream) =
        http.download(photo.uri.host!!, mediaPath("image", photo.uri), output)

    internal fun derivative(photo: Photo, edge: Int, etag: String?): CloudResponse? {
        fun get(route: String) =
            http.request(
                photo.uri.host!!,
                mediaPath(route, photo.uri),
                headers = etag?.let { mapOf("If-None-Match" to it) } ?: emptyMap(),
            )
        val primary = get(if (edge > 512) "preview" else "thumb")
        val response = if (primary.status == 404 && edge > 512) get("thumb") else primary
        if (response.status == 202) {
            val seconds = response.retryAfter?.toLongOrNull()?.coerceIn(1, 60) ?: 2
            throw CloudDerivativePending(seconds * 1_000)
        }
        return when (response.status) {
            404 -> null
            304 -> response
            else -> response.requireSuccess()
        }
    }

    private fun sidecar(uri: Uri): CloudResponse = http.request(uri.host!!, xmpPath(uri))

    fun readSidecar(photo: Photo): String? {
        val response = sidecar(photo.uri)
        return if (response.status == 404) null
        else XmpEncoding.forCloud(response.requireSuccess().xmp())
    }

    fun save(photo: Photo, document: XmpDocument, baseline: String?): LoadedSidecar {
        val current = sidecar(photo.uri)
        val xml =
            if (current.status == 404) null
            else XmpEncoding.forCloud(current.requireSuccess().xmp())
        check(xml == baseline) {
            "The cloud sidecar changed outside Maple. Reopen the photo before saving."
        }
        check(current.preconditions == "content-etag-v1") {
            "Update this Maple server to support safe conditional sidecar saves."
        }
        val headers =
            if (baseline == null) mapOf("If-None-Match" to "*")
            else {
                val etag =
                    current.etag ?: error("Cloud sidecar response is missing its content ETag")
                check(etag.startsWith('"') && etag.endsWith('"') && !etag.contains(',')) {
                    "Cloud sidecar ETag is invalid"
                }
                mapOf("If-Match" to etag)
            }
        val serialized = XmpEncoding.forCloud(document.serialize())
        http
            .request(
                photo.uri.host!!,
                xmpPath(photo.uri),
                "POST",
                serialized,
                headers + ("Content-Type" to "application/rdf+xml"),
            )
            .requireSuccess()
        return LoadedSidecar(XmpDocument(serialized), serialized)
    }

    companion object {
        fun isCloud(uri: Uri) = uri.scheme == "maple-cloud"

        private fun root(id: String): Uri =
            Uri.Builder().scheme("maple-cloud").authority(id).build()

        private fun address(id: String, address: String, path: String): Uri =
            root(id)
                .buildUpon()
                .appendQueryParameter("address", address)
                .appendQueryParameter("path", path)
                .build()

        private fun xmpPath(uri: Uri) =
            "/api/xmp?path=${Uri.encode(uri.getQueryParameter("path") ?: error("Missing cloud photo path"))}"

        internal fun mediaPath(route: String, uri: Uri): String {
            val address = uri.getQueryParameter("address") ?: error("Missing cloud address")
            require(':' in address)
            val slug = address.substringBefore(':')
            val relative = address.substringAfter(':')
            require(
                slug.matches(Regex("[A-Za-z0-9_-]+")) &&
                    relative.split('/').none { it == ".." || it == "." }
            ) {
                "Invalid cloud library address"
            }
            return "/api/$route/${Uri.encode(slug)}/" +
                relative.split('/').joinToString("/") { Uri.encode(it) }
        }
    }
}
