package app.justmaple.aperture.data

import android.net.Uri
import android.util.Base64
import app.justmaple.aperture.cloud.CloudHttp
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.cloud.CloudSessions
import com.sun.net.httpserver.HttpServer
import java.awt.image.BufferedImage
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import javax.imageio.ImageIO

/** An in-process Maple server for the thumbnail and original routes; it counts requests and body bytes. */
internal class CloudTileServer : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val log = CopyOnWriteArrayList<String>()
    private val thumbnailBytes = AtomicLong()
    val savesReceived = AtomicLong()
    @Volatile var failSaves = false
    private val originalBytes = AtomicLong()
    val id = "0f3c2c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    val original = ByteArray(50_000) { (it % 251).toByte() }
    @Volatile var thumbnail = ByteArray(5_836) { (it % 241).toByte() }
    val account = CloudServer(id, "http://127.0.0.1:${server.address.port}", accessToken(), "refresh")
    val http = CloudHttp(Sessions(account))
    val requests: List<String>
        get() = log.toList()
    val thumbnailRequests: List<String>
        get() = requests.filter { "/api/thumb/" in it }
    val originalRequests: List<String>
        get() = requests.filter { "/api/image/" in it }
    val thumbnailBytesServed: Long
        get() = thumbnailBytes.get()
    val previewRequests: List<String>
        get() = requests.filter { "/api/preview/" in it }
    val originalBytesServed: Long
        get() = originalBytes.get()

    init {
        server.createContext("/api/thumb/") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            val validator = "\"${thumbnail.contentHashCode()}\""
            val offered = exchange.requestHeaders.getFirst("If-None-Match")
            log += "${exchange.requestURI} if-none-match=${offered ?: "-"}"
            exchange.responseHeaders.add("ETag", validator)
            if (offered == validator) exchange.sendResponseHeaders(304, -1)
            else {
                val body = thumbnail
                thumbnailBytes.addAndGet(body.size.toLong())
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            exchange.close()
        }
        server.createContext("/api/preview/") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            log += "${exchange.requestURI} if-none-match=-"
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
        }
        server.createContext("/api/image/") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            log += "${exchange.requestURI} if-none-match=-"
            originalBytes.addAndGet(original.size.toLong())
            exchange.sendResponseHeaders(200, original.size.toLong())
            exchange.responseBody.use { it.write(original) }
            exchange.close()
        }
        server.createContext("/api/xmp") { exchange ->
            exchange.requestBody.use { it.readBytes() }
            exchange.responseHeaders.add("X-Maple-Xmp-Preconditions", "content-etag-v1")
            val posted = exchange.requestMethod == "POST"
            if (posted) savesReceived.incrementAndGet()
            exchange.sendResponseHeaders(if (posted && !failSaves) 200 else if (posted) 500 else 404, -1)
            exchange.close()
        }
        server.start()
    }

    fun photo(name: String = "a.dng", token: String? = null) =
        Photo(
            CloudLibrary.address(id, "lib:2026/$name", "/photos/2026/$name"),
            name,
            original.size.toLong(),
            1_700_000_000_000L,
            null,
            thumbToken = token,
        )

    override fun close() = server.stop(0)

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

    companion object {
        private fun accessToken(): String {
            fun part(json: String) =
                Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            return "${part("{\"alg\":\"HS256\"}")}.${part("{\"sub\":\"ann\"}")}.signature"
        }

        fun writePng(destination: String) {
            check(ImageIO.write(BufferedImage(8, 6, BufferedImage.TYPE_INT_RGB), "png", File(destination)))
        }
    }
}
