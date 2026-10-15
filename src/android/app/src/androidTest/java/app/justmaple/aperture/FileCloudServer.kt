package app.justmaple.aperture

import app.justmaple.aperture.cloud.CloudLogin
import java.io.Closeable
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/** Real HTTP and real sidecars for Android cloud contract tests. No original write route. */
internal class FileCloudServer(private val directory: File) : Closeable {
    private val socket = ServerSocket(0, 20, java.net.InetAddress.getByName("127.0.0.1"))
    private val worker = Executors.newCachedThreadPool()
    val origin = "http://127.0.0.1:${socket.localPort}"
    @Volatile var expectedChallenge = ""
    @Volatile var expectedState = ""
    @Volatile var claimReady = false
    @Volatile var claimCount = 0
    @Volatile var claimTransientStatus: Int? = null
    @Volatile
    var refreshCount = 0
        private set

    @Volatile var forceRefresh = false
    @Volatile var refreshEntered: java.util.concurrent.CountDownLatch? = null
    @Volatile var releaseRefresh: java.util.concurrent.CountDownLatch? = null
    @Volatile var redeemEntered: java.util.concurrent.CountDownLatch? = null
    @Volatile var releaseRedeem: java.util.concurrent.CountDownLatch? = null
    @Volatile var logoutEntered = java.util.concurrent.CountDownLatch(1)
    @Volatile var releaseLogout: java.util.concurrent.CountDownLatch? = null
    @Volatile var saveEntered: java.util.concurrent.CountDownLatch? = null
    @Volatile var releaseSave: java.util.concurrent.CountDownLatch? = null
    @Volatile var saveCount = 0
    @Volatile var loadEntered: java.util.concurrent.CountDownLatch? = null
    @Volatile var releaseLoad: java.util.concurrent.CountDownLatch? = null
    @Volatile var previewPendingResponses = 0
    @Volatile var previewCount = 0
    @Volatile var previewSuccesses = 0
    @Volatile var thumbCount = 0
    @Volatile private var access = "fixture-access-1"
    private var refresh = "fixture-refresh-1"
    val original = File(directory, "photo #😀.png")
    val sidecar = File(directory, "photo #😀.xmp")
    val derivative = File(directory, "rendered.png")
    @Volatile var derivativeTransfers = 0
    @Volatile var derivativeNotModified = 0

    init {
        worker.submit {
            while (!socket.isClosed) {
                try {
                    socket.accept().let { client -> worker.submit { client.use(::serve) } }
                } catch (_: java.net.SocketException) {
                    if (!socket.isClosed) throw IllegalStateException("Fixture server stopped")
                }
            }
        }
    }

    private fun serve(client: Socket) {
        client.soTimeout = 10_000
        val input = client.getInputStream().buffered()
        fun line(): String = buildString {
            while (true) {
                val next = input.read()
                check(next >= 0)
                if (next == 10) break
                if (next != 13) append(next.toChar())
            }
        }
        val request = line().split(' ')
        val headers = buildMap {
            while (true) {
                val next = line()
                if (next.isEmpty()) break
                put(next.substringBefore(':').lowercase(), next.substringAfter(':').trim())
            }
        }
        val body = ByteArray(headers["content-length"]?.toInt() ?: 0)
        var read = 0
        while (read < body.size) {
            val count = input.read(body, read, body.size - read)
            check(count > 0)
            read += count
        }
        val path = android.net.Uri.parse(request[1])
        fun respond(
            code: Int,
            bytes: ByteArray = ByteArray(0),
            extra: Map<String, String> = emptyMap(),
        ) {
            val output = client.getOutputStream()
            output.write(
                ("HTTP/1.1 $code Fixture\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n" +
                        extra.entries.joinToString("") { "${it.key}: ${it.value}\r\n" } +
                        "\r\n")
                    .toByteArray()
            )
            output.write(bytes)
            output.flush()
        }
        fun json(code: Int, value: Any) =
            respond(
                code,
                value.toString().toByteArray(),
                mapOf("Content-Type" to "application/json"),
            )
        fun tokens() =
            JSONObject()
                .put("access_token", access)
                .put("refresh_token", refresh)
                .put("user", JSONObject().put("id", "fixture-user").put("file_access", true))
        fun derivativeResponse() {
            val bytes = (derivative.takeIf { it.isFile } ?: original).readBytes()
            val etag =
                "\"" +
                    MessageDigest.getInstance("SHA-256")
                        .digest(path.path.orEmpty().toByteArray() + bytes)
                        .joinToString("") { "%02x".format(it) } +
                    "\""
            val extra =
                mapOf(
                    "ETag" to etag,
                    "Content-Type" to "image/png",
                    "Cache-Control" to "must-revalidate",
                )
            if (headers["if-none-match"] == etag) {
                derivativeNotModified++
                respond(304, extra = extra)
            } else {
                derivativeTransfers++
                respond(200, bytes, extra)
            }
        }
        when (path.path) {
            "/api/auth/native-code/claim" -> {
                val data = JSONObject(body.toString(Charsets.UTF_8))
                claimCount++
                val transient = claimTransientStatus
                if (transient != null) {
                    claimTransientStatus = null
                    respond(transient)
                } else if (
                    !claimReady ||
                        data.optString("state") != expectedState ||
                        CloudLogin.challenge(data.optString("code_verifier")) != expectedChallenge
                ) {
                    respond(404)
                } else {
                    claimReady = false
                    json(200, tokens())
                }
            }
            "/api/auth/native-code/redeem" -> {
                val data = JSONObject(body.toString(Charsets.UTF_8))
                if (
                    data.optString("code") != "fixture-code" ||
                        CloudLogin.challenge(data.getString("code_verifier")) != expectedChallenge
                )
                    json(401, JSONObject())
                else {
                    redeemEntered?.countDown()
                    check(releaseRedeem?.await(10, java.util.concurrent.TimeUnit.SECONDS) != false)
                    json(200, tokens())
                }
            }
            "/api/auth/refresh" -> {
                if (JSONObject(body.toString(Charsets.UTF_8)).optString("refresh_token") != refresh)
                    json(401, JSONObject())
                else {
                    refreshEntered?.countDown()
                    check(releaseRefresh?.await(10, java.util.concurrent.TimeUnit.SECONDS) != false)
                    refreshCount++
                    access = "fixture-access-${refreshCount + 1}"
                    refresh = "fixture-refresh-${refreshCount + 1}"
                    forceRefresh = false
                    json(200, tokens())
                }
            }
            "/api/auth/logout" -> {
                logoutEntered.countDown()
                check(releaseLogout?.await(10, java.util.concurrent.TimeUnit.SECONDS) != false)
                json(200, JSONObject().put("ok", true))
            }
            else -> {
                if (forceRefresh || headers["authorization"] != "Bearer $access") {
                    respond(401)
                    return
                }
                when (path.path) {
                    "/api/folders" ->
                        json(
                            200,
                            JSONArray()
                                .put(
                                    JSONObject()
                                        .put("id", "fixture-library")
                                        .put("slug", "photos")
                                        .put("path", directory.path)
                                        .put("label", "Fixture photos")
                                ),
                        )
                    "/api/folder/photos/" ->
                        json(
                            200,
                            JSONObject()
                                .put(
                                    "folders",
                                    JSONArray()
                                        .put(
                                            JSONObject()
                                                .put("name", "2026")
                                                .put("address", "photos:2026")
                                                .put("path", directory.path + "/2026")
                                        ),
                                )
                                .put("images", JSONArray()),
                        )
                    "/api/folder/photos/2026" ->
                        json(
                            200,
                            JSONObject()
                                .put("parent", "photos:")
                                .put("parentPath", directory.path)
                                .put("folders", JSONArray())
                                .put(
                                    "images",
                                    JSONArray()
                                        .put(
                                            JSONObject()
                                                .put("name", original.name)
                                                .put("address", "photos:2026/" + original.name)
                                                .put("path", original.path)
                                                .put("size", original.length())
                                                .put("mtime", "2026-10-14T00:00:00.123Z")
                                        ),
                                ),
                        )
                    "/api/image/photos/2026/" + original.name -> respond(200, original.readBytes())
                    "/api/thumb/photos/2026/" + original.name -> {
                        thumbCount++
                        derivativeResponse()
                    }
                    "/api/preview/photos/2026/" + original.name -> {
                        previewCount++
                        if (previewPendingResponses > 0) {
                            previewPendingResponses--
                            respond(202, extra = mapOf("Retry-After" to "1"))
                        } else {
                            previewSuccesses++
                            derivativeResponse()
                        }
                    }
                    "/api/xmp" -> {
                        check(path.getQueryParameter("path") == original.path)
                        val present = sidecar.isFile
                        val etag =
                            if (present) {
                                val hash = MessageDigest.getInstance("SHA-1")
                                sidecar.inputStream().use { input ->
                                    val chunk = ByteArray(8192)
                                    while (true) {
                                        val count = input.read(chunk)
                                        if (count < 0) break
                                        hash.update(chunk, 0, count)
                                    }
                                }
                                "\"" + hash.digest().joinToString("") { "%02x".format(it) } + "\""
                            } else null
                        val extra =
                            mapOf("X-Maple-Xmp-Preconditions" to "content-etag-v1") +
                                if (etag == null) emptyMap() else mapOf("ETag" to etag)
                        if (request[0] == "GET") {
                            loadEntered?.countDown()
                            check(
                                releaseLoad?.await(10, java.util.concurrent.TimeUnit.SECONDS) !=
                                    false
                            )
                            if (!present) respond(404, extra = extra)
                            else {
                                val output = client.getOutputStream()
                                output.write(
                                    ("HTTP/1.1 200 Fixture\r\nContent-Length: ${sidecar.length()}\r\nConnection: close\r\n" +
                                            extra.entries.joinToString("") {
                                                "${it.key}: ${it.value}\r\n"
                                            } +
                                            "\r\n")
                                        .toByteArray()
                                )
                                sidecar.inputStream().use { it.copyTo(output) }
                                output.flush()
                            }
                        } else if (
                            (!present && headers["if-none-match"] == "*") ||
                                (present && headers["if-match"] == etag)
                        ) {
                            saveEntered?.countDown()
                            check(
                                releaseSave?.await(10, java.util.concurrent.TimeUnit.SECONDS) !=
                                    false
                            )
                            sidecar.writeBytes(body)
                            saveCount++
                            json(200, JSONObject().put("ok", true))
                        } else respond(412)
                    }
                    else -> respond(404)
                }
            }
        }
    }

    override fun close() {
        socket.close()
        worker.shutdownNow()
    }
}
