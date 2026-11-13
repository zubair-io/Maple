package app.justmaple.aperture

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertNotNull

/**
 * The real Maple API started by `scripts/with-cloud-api.sh` (reverse-forwarded to the
 * device's loopback). Tests sign in with the server's development login and store the
 * tokens exactly where the app keeps them.
 */
internal class MapleApiFixture {
    val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val arguments = InstrumentationRegistry.getArguments()
    val origin: String =
        requireNotNull(arguments.getString("mapleApiOrigin")) {
            "Run device tests through scripts/with-cloud-api.sh: it starts the real Maple API"
        }
    val nativeEngine = arguments.getString("mapleApiNative") == "1"
    val credentials = CloudCredentials(context)
    val server: CloudServer
    val library: JSONObject

    init {
        val login = URL("$origin/api/auth/dev-login").openConnection() as HttpURLConnection
        login.requestMethod = "POST"
        login.doOutput = true
        login.setRequestProperty("Content-Type", "application/json")
        login.outputStream.use { it.write("{}".toByteArray()) }
        check(login.responseCode == 200) { "Development login failed: HTTP ${login.responseCode}" }
        val access = JSONObject(login.inputStream.bufferedReader().readText()).getString("access_token")
        val refresh =
            login.headerFields.entries
                .filter { it.key.equals("set-cookie", ignoreCase = true) }
                .flatMap { it.value }
                .first { it.startsWith("maple_refresh=") }
                .substringAfter('=')
                .substringBefore(';')
        login.disconnect()
        server = CloudServer(UUID.randomUUID().toString(), origin, access, refresh)
        credentials.save(server)
        library =
            JSONArray(request("GET", "/api/folders").second).let { libraries ->
                (0 until libraries.length())
                    .map { libraries.getJSONObject(it) }
                    .first { it.getString("label") == "Android provider fixture" }
            }
    }

    val libraryId: String = library.getString("id")
    val slug: String = library.getString("slug")

    fun current(): CloudServer = credentials.servers().first { it.id == server.id }

    fun request(
        method: String,
        path: String,
        body: ByteArray? = null,
        headers: Map<String, String> = emptyMap(),
    ): Pair<Int, String> {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.setRequestProperty("Authorization", "Bearer ${current().access}")
        headers.forEach(connection::setRequestProperty)
        if (body != null) {
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
        }
        val status = connection.responseCode
        val text =
            (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()
                ?.readText()
                .orEmpty()
        connection.disconnect()
        return status to text
    }

    /** Another device writing straight to the server, outside this provider. */
    fun upload(path: String, bytes: ByteArray): JSONObject {
        val (status, text) =
            request(
                "POST",
                "/api/folders/$libraryId/upload",
                bytes,
                mapOf(
                    "X-Maple-Target-Path" to path.split('/').joinToString("/") { Uri.encode(it) },
                    "Content-Type" to "application/octet-stream",
                ),
            )
        check(status == 201) { "Fixture upload failed: HTTP $status $text" }
        return JSONObject(text)
    }

    fun serverBytes(path: String): ByteArray? {
        val connection =
            URL("$origin/api/folders/$libraryId/file?path=${Uri.encode(path)}").openConnection()
                as HttpURLConnection
        connection.setRequestProperty("Authorization", "Bearer ${current().access}")
        return try {
            if (connection.responseCode == 404) null else connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    fun trashedNames(): List<String> {
        val items = JSONObject(request("GET", "/api/folders/$libraryId/trash?limit=200").second).getJSONArray("items")
        return (0 until items.length()).map { items.getJSONObject(it).getString("filename") }
    }

    fun close() = credentials.remove(server.id)

    companion object {
        const val AUTHORITY = "app.justmaple.aperture.documents"

        fun documentUri(id: String): Uri = DocumentsContract.buildDocumentUri(AUTHORITY, id)

        fun childrenUri(id: String): Uri = DocumentsContract.buildChildDocumentsUri(AUTHORITY, id)

        fun rows(cursor: Cursor?): List<Map<String, Any?>> {
            assertNotNull("The provider returned no cursor", cursor)
            return cursor!!.use {
                buildList {
                    while (it.moveToNext())
                        add(
                            mapOf(
                                "id" to it.getString(it.getColumnIndexOrThrow(Document.COLUMN_DOCUMENT_ID)),
                                "name" to it.getString(it.getColumnIndexOrThrow(Document.COLUMN_DISPLAY_NAME)),
                                "mime" to it.getString(it.getColumnIndexOrThrow(Document.COLUMN_MIME_TYPE)),
                                "size" to it.getLongOrNull(Document.COLUMN_SIZE),
                                "flags" to it.getInt(it.getColumnIndexOrThrow(Document.COLUMN_FLAGS)),
                            )
                        )
                }
            }
        }

        private fun Cursor.getLongOrNull(column: String): Long? {
            val index = getColumnIndexOrThrow(column)
            return if (isNull(index)) null else getLong(index)
        }
    }
}
