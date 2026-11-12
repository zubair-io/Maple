package app.justmaple.aperture.cloud

import android.os.CancellationSignal
import android.os.OperationCanceledException
import app.justmaple.aperture.data.XmpEncoding
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.io.StringReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import org.json.JSONObject

/** A non-success response; the status lets callers tell missing items from failures. */
internal class CloudStatusException(val status: Int, message: String) :
    IllegalStateException(message)

internal data class CloudResponse(
    val status: Int,
    private val body: ByteArray,
    val etag: String?,
    val preconditions: String?,
    val retryAfter: String? = null,
    val size: Int = body.size,
) {
    fun text() = String(body, 0, size, Charsets.UTF_8)

    fun xmp() = XmpEncoding.decode(body, size)

    fun bytes(): ByteBuffer = ByteBuffer.wrap(body, 0, size).slice().asReadOnlyBuffer()

    fun writeTo(output: OutputStream) = output.write(body, 0, size)

    fun requireSuccess(): CloudResponse = apply {
        if (status !in 200..299)
            throw CloudStatusException(
                status,
                when (status) {
                    401 -> "Cloud session expired. Reconnect this server in Settings."
                    403 -> "Your account does not have access to this library."
                    412 ->
                        "The cloud sidecar changed outside Maple. Reopen the photo before saving."
                    else -> "Cloud request failed (HTTP $status). Please try again."
                },
            )
    }
}

/** The authenticated server calls the documents provider makes; tests serve them in-process. */
internal interface CloudTransport {
    fun request(
        id: String,
        path: String,
        method: String = "GET",
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
    ): CloudResponse

    fun download(id: String, path: String, output: OutputStream, signal: CancellationSignal? = null)

    fun upload(id: String, path: String, file: File, headers: Map<String, String>): CloudResponse
}

internal class CloudHttp(private val credentials: CloudCredentials) : CloudTransport {
    override fun request(
        id: String,
        path: String,
        method: String,
        body: String?,
        headers: Map<String, String>,
    ): CloudResponse =
        authenticated(id, path, method, body, headers) { connection ->
            read(connection, if (path.substringBefore('?') == "/api/xmp") 128 else 16)
        }

    /** Streams the body; cancelling the signal aborts the socket mid-transfer. */
    override fun download(id: String, path: String, output: OutputStream, signal: CancellationSignal?) {
        try {
            authenticated(id, path, "GET", null, emptyMap(), watch = signal) { connection ->
                if (connection.responseCode != 200)
                    throw CloudStatusException(
                        connection.responseCode,
                        "Cloud download failed (HTTP ${connection.responseCode})",
                    )
                connection.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        signal?.throwIfCanceled()
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                    }
                }
            }
        } catch (failure: IOException) {
            signal?.throwIfCanceled()
            throw failure
        } finally {
            signal?.setOnCancelListener(null)
        }
    }

    /** Sends the file with a fixed length; the body is re-read if a token refresh retries. */
    override fun upload(id: String, path: String, file: File, headers: Map<String, String>): CloudResponse =
        authenticated(id, path, "POST", null, headers, upload = file) { read(it) }

    // Logout and refresh share a lane: a refresh cannot publish tokens after removal.
    // The lane is process-wide: the app and the documents provider hold separate
    // clients over one credential store, and refresh tokens rotate on every use.
    fun disconnect(id: String) {
        val current =
            synchronized(REFRESH_LOCK) {
                val server = credentials.servers().find { it.id == id } ?: return
                credentials.remove(id)
                server
            }
        // Removal waits for any in-flight refresh and prevents later refreshes
        // from publishing. Revoking its latest token needs no global HTTP lock.
        publicPost(
                current.origin,
                "/api/auth/logout",
                JSONObject().put("refresh_token", current.refresh),
            )
            .requireSuccess()
    }

    private fun <T> authenticated(
        id: String,
        path: String,
        method: String,
        body: String?,
        headers: Map<String, String>,
        upload: File? = null,
        watch: CancellationSignal? = null,
        read: (HttpURLConnection) -> T,
    ): T {
        require(path.startsWith("/api/"))
        val server = server(id)
        val connection =
            open(
                server.origin,
                path,
                method,
                body,
                headers + ("Authorization" to "Bearer ${server.access}"),
                upload,
                watch,
            )
        if (connection.responseCode != 401)
            return try {
                read(connection)
            } finally {
                connection.disconnect()
            }
        connection.disconnect()
        val renewed =
            synchronized(REFRESH_LOCK) {
                val current = server(id)
                if (current.access != server.access) current
                else {
                    val response =
                        publicPost(
                                current.origin,
                                "/api/auth/refresh",
                                JSONObject().put("refresh_token", current.refresh),
                            )
                            .requireSuccess()
                    val tokens = JSONObject(response.text())
                    current
                        .copy(
                            access = tokens.getString("access_token"),
                            refresh = tokens.getString("refresh_token"),
                        )
                        .also(credentials::save)
                }
            }
        val retry =
            open(
                renewed.origin,
                path,
                method,
                body,
                headers + ("Authorization" to "Bearer ${renewed.access}"),
                upload,
                watch,
            )
        return try {
            read(retry)
        } finally {
            retry.disconnect()
        }
    }

    private fun server(id: String) =
        credentials.servers().find { it.id == id } ?: error("Cloud connection was removed")

    companion object {
        private val REFRESH_LOCK = Any()

        fun publicPost(origin: String, path: String, json: JSONObject): CloudResponse {
            val connection =
                open(
                    origin,
                    path,
                    "POST",
                    json.toString(),
                    mapOf("Content-Type" to "application/json"),
                )
            return try {
                read(connection)
            } finally {
                connection.disconnect()
            }
        }

        private fun open(
            origin: String,
            path: String,
            method: String,
            body: String?,
            headers: Map<String, String>,
            upload: File? = null,
            watch: CancellationSignal? = null,
        ): HttpURLConnection {
            val connection = URL(origin + path).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 20_000
            connection.readTimeout = 60_000
            connection.requestMethod = method
            headers.forEach(connection::setRequestProperty)
            try {
                watch?.let { signal ->
                    signal.setOnCancelListener { connection.disconnect() }
                    if (signal.isCanceled) throw OperationCanceledException()
                }
                if (body != null) {
                    val length = utf8Length(body)
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(length)
                    StringReader(body).use { input ->
                        OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { output ->
                            input.copyTo(output, 4096)
                        }
                    }
                }
                if (upload != null) {
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(upload.length())
                    upload.inputStream().use { input ->
                        connection.outputStream.use { input.copyTo(it, 64 * 1024) }
                    }
                }
                return connection
            } catch (failure: Exception) {
                connection.disconnect()
                throw failure
            }
        }

        private fun utf8Length(text: String): Long {
            var index = 0
            var bytes = 0L
            while (index < text.length) {
                val character = text[index++]
                bytes +=
                    when {
                        character.code < 0x80 -> 1
                        character.code < 0x800 -> 2
                        Character.isHighSurrogate(character) -> {
                            require(
                                index < text.length && Character.isLowSurrogate(text[index++])
                            ) {
                                "Invalid Unicode in cloud request"
                            }
                            4
                        }
                        Character.isLowSurrogate(character) ->
                            error("Invalid Unicode in cloud request")
                        else -> 3
                    }
            }
            return bytes
        }

        private fun read(connection: HttpURLConnection, limitMiB: Int = 16): CloudResponse {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val limit = limitMiB * 1024 * 1024
            val declared = connection.contentLengthLong
            check(declared <= limit) { "Cloud response exceeded $limitMiB MiB" }
            val output = ResponseBuffer(if (declared >= 0) declared.toInt() else 8192, limit)
            stream?.use {
                val buffer = ByteArray(8192)
                while (true) {
                    val count = it.read(buffer)
                    if (count < 0) break
                    check(output.size + count <= limit) {
                        "Cloud response exceeded $limitMiB MiB"
                    }
                    output.write(buffer, count)
                }
            }
            return CloudResponse(
                status,
                output.buffer,
                connection.getHeaderField("ETag"),
                connection.getHeaderField("X-Maple-Xmp-Preconditions"),
                connection.getHeaderField("Retry-After"),
                output.size,
            )
        }

        /** The response owns this bounded buffer; publication never clones it. */
        private class ResponseBuffer(capacity: Int, private val limit: Int) {
            var buffer = ByteArray(capacity)
                private set

            var size = 0
                private set

            fun write(input: ByteArray, count: Int) {
                val required = size + count
                if (required > buffer.size)
                    buffer = buffer.copyOf(maxOf(required, minOf(limit, buffer.size * 2)))
                input.copyInto(buffer, size, 0, count)
                size = required
            }
        }
    }
}
