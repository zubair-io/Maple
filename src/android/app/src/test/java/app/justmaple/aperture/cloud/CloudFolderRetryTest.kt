package app.justmaple.aperture.cloud

import android.util.Base64
import app.justmaple.aperture.documents.CloudDocumentId
import app.justmaple.aperture.documents.CloudDocumentsApi
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudFolderRetryTest {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val origin = "http://127.0.0.1:${server.address.port}"
    private val id = "0f3c2c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    private val http = CloudHttp(Sessions(CloudServer(id, origin, token(), "refresh")))
    private val seen = mutableListOf<String>()
    private val requests get() = synchronized(seen) { seen.toList() }
    private val listing = """{"folders":[],"images":[{"name":"a.CR2","address":"lib:a.CR2","path":"a.CR2"}],"next_cursor":"c2"}"""
    private val conflict = """{"error":"Folder changed while it was being listed; retry."}"""

    @After
    fun stop() = server.stop(0)

    @Volatile private var answers = listOf<Pair<Int, String>>()
    private var started = false

    private fun serve(vararg script: Pair<Int, String>) {
        synchronized(seen) {
            seen.clear()
            answers = script.toList()
        }
        if (started) return
        started = true
        server.createContext("/") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            val index =
                synchronized(seen) {
                    seen += "${exchange.requestMethod} ${exchange.requestURI}"
                    minOf(seen.size, answers.size) - 1
                }
            val (status, text) = answers[index]
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    private val folder = CloudDocumentId(id, true, "library-id", "lib", "Trip")

    @Test
    fun aConflictOnAListingIsAskedAgainOnceAndTheSecondAnswerIsUsed() {
        serve(409 to conflict, 200 to listing)
        val page = CloudDocumentsApi(http).page(folder, null)
        assertEquals("c2", page.next)
        assertEquals(listOf("a.CR2"), page.entries.map { it.name })
        assertEquals(2, requests.size)
        assertEquals(requests[0], requests[1])
        assertFalse(requests[0], requests[0].contains("cursor"))
    }

    @Test
    fun aConflictOnAPageWithACursorIsReportedWithoutAskingAgain() {
        serve(409 to conflict)
        val failure = assertThrows(CloudStatusException::class.java) { CloudDocumentsApi(http).page(folder, "c1") }
        assertEquals(409, failure.status)
        assertEquals(1, requests.size)
        assertTrue(requests[0], requests[0].contains("cursor=c1"))
        assertEquals(409, http.request(id, "/api/folder/lib/Trip?limit=500&cursor=c1").status)
        assertEquals(2, requests.size)
    }

    @Test
    fun aFileNamedLikeACursorParameterNeitherBlocksNorTriggersTheRetry() {
        serve(409 to conflict, 200 to listing)
        assertEquals(200, http.request(id, "/api/folder/lib/cursor%3Dx?limit=500").status)
        assertEquals(2, requests.size)
    }

    @Test
    fun theBrowseListingRequestIsRetriedToo() {
        serve(409 to conflict, 200 to listing)
        val response = http.request(id, "/api/folder/lib/Trip?limit=500&stack=1").requireSuccess()
        assertEquals(200, response.status)
        assertEquals(2, requests.size)
    }

    @Test
    fun aSecondConflictIsReportedAsAConflictAfterExactlyTwoRequests() {
        serve(409 to conflict)
        val failure = assertThrows(CloudStatusException::class.java) { CloudDocumentsApi(http).page(folder, null) }
        assertEquals(409, failure.status)
        assertEquals(2, requests.size)
        assertEquals(409, http.request(id, "/api/folder/lib/Trip").status)
        assertEquals(4, requests.size)
    }

    @Test
    fun otherFailuresOnAListingAreNotAskedAgain() {
        for (status in listOf(404, 500)) {
            serve(status to """{"error":"x"}""", 200 to listing)
            assertEquals(status, http.request(id, "/api/folder/lib/Trip").status)
            assertEquals(1, requests.size)
        }
    }

    @Test
    fun aConflictOnAnyOtherRouteOrMethodIsNotAskedAgain() {
        serve(409 to conflict)
        assertEquals(409, http.request(id, "/api/folders/a/file-meta?path=x").status)
        assertEquals(409, http.request(id, "/api/folder/lib/Trip", "POST", "{}").status)
        assertEquals(listOf("GET /api/folders/a/file-meta?path=x", "POST /api/folder/lib/Trip"), requests)
    }

    private class Sessions(initial: CloudServer) : CloudSessions {
        private var current = listOf(initial)

        @Synchronized override fun servers() = current

        @Synchronized
        override fun save(server: CloudServer) {
            current = current.filter { it.id != server.id } + server
        }

        @Synchronized
        override fun remove(id: String) {
            current = current.filter { it.id != id }
        }
    }

    private companion object {
        fun token(): String {
            fun part(json: String) =
                Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            return "${part("{\"alg\":\"HS256\"}")}.${part("{\"sub\":\"ann\"}")}.signature"
        }
    }
}
