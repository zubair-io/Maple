package app.justmaple.aperture.cloud

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

internal data class CloudResponse(
    val status: Int,
    val body: ByteArray,
    val etag: String?,
    val preconditions: String?,
    val retryAfter: String? = null,
) {
    fun text() = body.toString(Charsets.UTF_8)

    fun requireSuccess(): CloudResponse = apply {
        check(status in 200..299) {
            when (status) {
                401 -> "Cloud session expired. Reconnect this server in Settings."
                403 -> "Your account does not have access to this library."
                412 -> "The cloud sidecar changed outside Maple. Reopen the photo before saving."
                else -> "Cloud request failed (HTTP $status). Please try again."
            }
        }
    }
}

internal class CloudHttp(private val credentials: CloudCredentials) {
    private val refreshLock = Any()

    fun request(
        id: String,
        path: String,
        method: String = "GET",
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
    ): CloudResponse =
        authenticated(id, path, method, body, headers) { connection -> read(connection) }

    fun download(id: String, path: String, output: OutputStream) {
        authenticated(id, path, "GET", null, emptyMap()) { connection ->
            check(connection.responseCode == 200) {
                "Cloud download failed (HTTP ${connection.responseCode})"
            }
            connection.inputStream.use { it.copyTo(output) }
        }
    }

    // Logout and refresh share a lane: a refresh cannot publish tokens after removal.
    fun disconnect(id: String): Unit =
        synchronized(refreshLock) {
            val current = credentials.servers().find { it.id == id } ?: return@synchronized
            try {
                request(
                        id,
                        "/api/auth/logout",
                        "POST",
                        JSONObject().put("refresh_token", current.refresh).toString(),
                        mapOf("Content-Type" to "application/json"),
                    )
                    .requireSuccess()
            } finally {
                credentials.remove(id)
            }
        }

    private fun <T> authenticated(
        id: String,
        path: String,
        method: String,
        body: String?,
        headers: Map<String, String>,
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
            )
        if (connection.responseCode != 401)
            return try {
                read(connection)
            } finally {
                connection.disconnect()
            }
        connection.disconnect()
        val renewed =
            synchronized(refreshLock) {
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
        ): HttpURLConnection {
            val connection = URL(origin + path).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 20_000
            connection.readTimeout = 60_000
            connection.requestMethod = method
            headers.forEach(connection::setRequestProperty)
            try {
                if (body != null) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                return connection
            } catch (failure: Exception) {
                connection.disconnect()
                throw failure
            }
        }

        private fun read(connection: HttpURLConnection): CloudResponse {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body =
                stream?.use {
                    val buffer = ByteArray(8192)
                    val output = java.io.ByteArrayOutputStream()
                    while (true) {
                        val count = it.read(buffer)
                        if (count < 0) break
                        check(output.size() + count <= 16 * 1024 * 1024) {
                            "Cloud response exceeded 16 MiB"
                        }
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                } ?: ByteArray(0)
            return CloudResponse(
                status,
                body,
                connection.getHeaderField("ETag"),
                connection.getHeaderField("X-Maple-Xmp-Preconditions"),
                connection.getHeaderField("Retry-After"),
            )
        }
    }
}
