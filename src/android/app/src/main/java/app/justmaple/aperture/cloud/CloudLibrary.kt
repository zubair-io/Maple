package app.justmaple.aperture.cloud

import android.content.Context
import android.net.Uri
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.OutputStream
import java.time.Instant
import kotlinx.coroutines.Dispatchers
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

    fun list(uri: Uri): LibraryListing {
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
        val listing = JSONObject(http.request(id, mediaPath("folder", uri)).requireSuccess().text())
        fun entry(value: JSONObject): Uri =
            address(id, value.getString("address"), value.getString("path"))
        val directories = listing.getJSONArray("folders")
        val images = listing.getJSONArray("images")
        val parentAddress = listing.optString("parent").takeIf { it.isNotEmpty() && it != "null" }
        val parent =
            if (parentAddress != null) address(id, parentAddress, listing.getString("parentPath"))
            else root(id)
        val folders =
            listOf(Folder(parent, "..")) +
                (0 until directories.length()).map {
                    val value = directories.getJSONObject(it)
                    Folder(entry(value), value.getString("name"))
                }
        val photos =
            (0 until images.length())
                .map { images.getJSONObject(it) }
                .filter {
                    it.getString("name").substringAfterLast('.', "").lowercase() in
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
        return LibraryListing(folders, photos)
    }

    fun copyOriginal(photo: Photo, output: OutputStream) =
        http.download(photo.uri.host!!, mediaPath("image", photo.uri), output)

    fun derivative(photo: Photo, edge: Int): ByteArray? {
        val response =
            http.request(
                photo.uri.host!!,
                mediaPath(if (edge > 512) "preview" else "thumb", photo.uri) +
                    "?pv=${AdjustmentFields.pipelineOutputVersion}",
            )
        if (response.status == 202) {
            val seconds = response.retryAfter?.toLongOrNull()?.coerceIn(1, 60) ?: 2
            throw CloudDerivativePending(seconds * 1_000)
        }
        if (response.status == 404) {
            if (edge <= 512) return null
            val thumb =
                http.request(
                    photo.uri.host!!,
                    mediaPath("thumb", photo.uri) + "?pv=${AdjustmentFields.pipelineOutputVersion}",
                )
            return if (thumb.status == 404) null else thumb.requireSuccess().body
        }
        return response.requireSuccess().body
    }

    private fun sidecar(uri: Uri): CloudResponse = http.request(uri.host!!, xmpPath(uri))

    fun readSidecar(photo: Photo): String? {
        val response = sidecar(photo.uri)
        return if (response.status == 404) null else response.requireSuccess().text()
    }

    fun save(photo: Photo, document: XmpDocument, baseline: String?): LoadedSidecar {
        val current = sidecar(photo.uri)
        val xml = if (current.status == 404) null else current.requireSuccess().text()
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
        val serialized = document.serialize()
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
