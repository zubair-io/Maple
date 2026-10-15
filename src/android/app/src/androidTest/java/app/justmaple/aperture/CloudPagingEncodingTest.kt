package app.justmaple.aperture

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import java.nio.charset.Charset
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CloudPagingEncodingTest {
    @Test
    fun folderPagingConsumesEmptyPagesAndOpaqueCursorsBeforePublishingTheCompleteList() =
        runBlocking {
            withCloud { server, library, folder ->
                fun page() =
                    JSONObject()
                        .put("parent", "photos:")
                        .put("parentPath", server.original.parent)
                        .put("folders", JSONArray())
                        .put("images", JSONArray())
                fun image(name: String) =
                    JSONObject()
                        .put("name", name)
                        .put("address", "photos:2026/$name")
                        .put("path", "${server.original.parent}/$name")
                        .put("size", 10)
                        .put("mtime", "2026-10-14T00:00:00.123Z")
                val opaque = "page #😀 &+/= cursor"
                val last = "third-page"
                server.folderPages =
                    mapOf(
                        null to
                            page()
                                .put(
                                    "files",
                                    JSONArray().put(JSONObject().put("name", "notes.xmp")),
                                )
                                .put("next_cursor", opaque),
                        opaque to
                            page()
                                .put(
                                    "folders",
                                    JSONArray()
                                        .put(
                                            JSONObject()
                                                .put("name", "Nested")
                                                .put("address", "photos:2026/Nested")
                                                .put("path", server.original.parent + "/Nested")
                                        ),
                                )
                                .put(
                                    "images",
                                    JSONArray().put(image("first.jpg")).put(image("skip.bmp")),
                                )
                                .put("next_cursor", last),
                        last to
                            page()
                                .put(
                                    "images",
                                    JSONArray().put(image("first.jpg")).put(image("last.dng")),
                                ),
                    )
                val listing = library.list(folder)
                assertEquals(listOf(null, opaque, last), server.folderCursors.toList())
                assertEquals(listOf("..", "Nested"), listing.folders.map { it.name })
                assertEquals(listOf("first.jpg", "last.dng"), listing.photos.map { it.name })
            }
        }

    @Test
    fun repeatedFolderCursorsFailInsteadOfLoopingForever() = runBlocking {
        withCloud { server, library, folder ->
            val page =
                JSONObject()
                    .put("folders", JSONArray())
                    .put("images", JSONArray())
                    .put("next_cursor", "repeated")
            server.folderPages = mapOf(null to page, "repeated" to page)
            val failure = runCatching { library.list(folder) }.exceptionOrNull()
            assertTrue(failure?.message.orEmpty().contains("repeated page cursor"))
            assertEquals(listOf(null, "repeated"), server.folderCursors.toList())
        }
    }

    @Test
    fun encodedCloudResponsesRetainForeignUnicodeWhenSavingThroughTheUtf8Api() = runBlocking {
        withCloud { server, library, folder ->
            val photo = library.list(folder).photos.single()
            val foreign = "<f:opaque xmlns:f='urn:foreign'>café 😀 &amp; light</f:opaque>"
            val source =
                "<?xml version='1.0' encoding='UTF-32'?>" +
                    XmpDocument.EMPTY.replace(
                        "rdf:about=\"\" />",
                        "rdf:about=\"\">$foreign</rdf:Description>",
                    )
            server.sidecar.writeBytes(
                byteArrayOf(-1, -2, 0, 0) + source.toByteArray(Charset.forName("UTF-32LE"))
            )
            val original = server.original.readBytes()
            val loaded = library.loadSidecar(photo)
            assertTrue(loaded.document.original.contains(foreign))
            val saved =
                library.save(
                    photo,
                    loaded.document.withAttribute("xmp:Rating", "4"),
                    loaded.baseline,
                )
            assertEquals(4, saved.document.rating)
            assertTrue(server.sidecar.readText().contains("encoding='UTF-8'"))
            assertTrue(server.sidecar.readText().contains(foreign))
            assertEquals(saved.baseline, library.loadSidecar(photo).baseline)
            assertArrayEquals(original, server.original.readBytes())
        }
    }

    private suspend fun withCloud(test: suspend (FileCloudServer, PhotoLibrary, Uri) -> Unit) {
        val i = InstrumentationRegistry.getInstrumentation()
        val context = i.targetContext
        val directory =
            File(context.cacheDir, "cloud-page-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        val id = java.util.UUID.randomUUID().toString()
        val credentials = CloudCredentials(context)
        try {
            FileCloudServer(directory).use { server ->
                i.context.assets.open("rgb-gradient.png").use { input ->
                    server.original.outputStream().use { input.copyTo(it) }
                }
                credentials.save(
                    CloudServer(id, server.origin, "fixture-access-1", "fixture-refresh-1")
                )
                val folder =
                    Uri.Builder()
                        .scheme("maple-cloud")
                        .authority(id)
                        .appendQueryParameter("address", "photos:2026")
                        .appendQueryParameter("path", directory.path)
                        .build()
                test(server, PhotoLibrary(context), folder)
            }
        } finally {
            credentials.remove(id)
            directory.deleteRecursively()
        }
    }
}
