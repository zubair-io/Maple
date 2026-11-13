package app.justmaple.aperture.cloud

import android.util.Base64
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** An upload carries only the session of the account whose journal record it sends. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudHttpAccountTest {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val origin = "http://127.0.0.1:${server.address.port}"
    private val id = "0f3c2c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    private val sessions = Sessions(CloudServer(id, origin, token("ann", 1), "ann-refresh"))
    private val seen = mutableListOf<String>()
    private val body = Files.createTempFile("upload", ".txt").toFile().apply { writeText("ann's bytes") }
    private val ann = "$origin#ann"

    @After
    fun stop() {
        server.stop(0)
        body.delete()
    }

    /** Records each request as `path user`; [answer] picks the status. */
    private fun serve(answer: (path: String, user: String) -> Pair<Int, String>) {
        server.createContext("/") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            val path = exchange.requestURI.path
            val user = exchange.requestHeaders.getFirst("Authorization")?.let(::user) ?: "-"
            synchronized(seen) { seen += "$path $user" }
            val (status, text) = answer(path, user)
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    private fun upload() =
        CloudHttp(sessions).upload(id, "/api/folders/a/upload", body, mapOf("X-Maple-Target-Path" to "a.txt"), ann)

    @Test
    fun anAccountSignedInBeforeTheSendStartsNeverCarriesIt() {
        serve { _, _ -> 201 to "{}" }
        sessions.save(CloudServer(id, origin, token("bob", 1), "bob-refresh"))
        assertThrows(CloudAccountChangedException::class.java) { upload() }
        assertTrue(seen.isEmpty())
    }

    @Test
    fun aRefreshRetryNeverSwitchesToAnotherAccountsSession() {
        serve { path, _ ->
            // Bob signs in on this connection while Ann's expired token is turned away.
            if (path.endsWith("/upload") && seen.size == 1)
                sessions.save(CloudServer(id, origin, token("bob", 1), "bob-refresh"))
            401 to "{}"
        }
        assertThrows(CloudAccountChangedException::class.java) { upload() }
        assertEquals(listOf("/api/folders/a/upload ann"), seen)
    }

    @Test
    fun theSameAccountStillRefreshesAndRetries() {
        serve { path, user ->
            when {
                path == "/api/auth/refresh" ->
                    200 to JSONObject().put("access_token", token("ann", 2)).put("refresh_token", "ann-2").toString()
                seen.size == 1 -> 401 to "{}"
                else -> 201 to "{\"user\":\"$user\"}"
            }
        }
        assertEquals(201, upload().status)
        assertEquals(listOf("/api/folders/a/upload ann", "/api/auth/refresh -", "/api/folders/a/upload ann"), seen)
        assertEquals("ann-2", sessions.servers().single().refresh)
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
        fun token(user: String, version: Int): String {
            fun part(json: String) =
                Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            return "${part("{\"alg\":\"HS256\"}")}.${part("{\"sub\":\"$user\",\"v\":$version}")}.signature"
        }

        fun user(authorization: String): String {
            val payload = authorization.removePrefix("Bearer ").split('.')[1]
            val json = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
            return JSONObject(json).getString("sub")
        }
    }
}
