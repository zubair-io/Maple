package app.justmaple.aperture.cloud

import android.net.Uri
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/** Browser callbacks and PKCE claims redeem in one lane; only an active ceremony can commit. */
internal class CloudSignIn(private val credentials: CloudCredentials) {
    private val lock = Any()
    private val exchangeLock = Mutex()
    private var epoch = 0
    val pending: Boolean
        get() = synchronized(lock) { credentials.pending() != null }

    fun begin(input: String): Uri =
        synchronized(lock) {
            val login = CloudLogin.create(input)
            ++epoch
            credentials.pending(login)
            login.browserUri()
        }

    fun cancel() =
        synchronized(lock) {
            ++epoch
            credentials.pending(null)
        }

    suspend fun complete(callback: Uri): CloudServer =
        exchange(callback) ?: throw CancellationException("Sign-in is no longer pending")

    suspend fun poll(): CloudServer? {
        val token = synchronized(lock) { epoch }
        while (pending) {
            currentCoroutineContext().ensureActive()
            synchronized(lock) {
                if (token != epoch) throw CancellationException("Sign-in was replaced")
            }
            exchange(null, token)?.let {
                return it
            }
            delay(2_000)
        }
        return null
    }

    private suspend fun exchange(callback: Uri?, expectedEpoch: Int? = null): CloudServer? =
        exchangeLock.withLock {
            // Retain a receipt outside withContext: cancellation can discard its return value
            // even after the IO block finished. Revoke and roll back that unpublished session.
            var receipt: Pair<CloudServer, CloudServer?>? = null
            var attempt: Int? = null
            var ceremony: CloudLogin? = null
            try {
                withContext(Dispatchers.IO) {
                    val (login, code, token) =
                        synchronized(lock) {
                            if (expectedEpoch != null && expectedEpoch != epoch)
                                throw CancellationException("Sign-in was replaced")
                            val login = credentials.pending() ?: return@withContext null
                            require(System.currentTimeMillis() - login.started in 0..600_000) {
                                "Sign-in expired. Please try again."
                            }
                            val code = callback?.let(login::validateCallback)
                            ceremony = login
                            attempt = epoch
                            if (callback != null) credentials.pending(null)
                            Triple(login, code, epoch)
                        }
                    val response =
                        try {
                            CloudHttp.publicPost(
                                login.origin,
                                if (callback == null) "/api/auth/native-code/claim"
                                else "/api/auth/native-code/redeem",
                                JSONObject().put("code_verifier", login.verifier).apply {
                                    if (callback == null) put("state", login.state)
                                    else put("code", code)
                                },
                            )
                        } catch (failure: IOException) {
                            if (callback == null) return@withContext null
                            throw failure
                        }
                    if (
                        callback == null &&
                            (response.status in setOf(404, 429) || response.status >= 500)
                    )
                        return@withContext null
                    response.requireSuccess()
                    val result = JSONObject(response.text())
                    val previous = credentials.servers().find { it.origin == login.origin }
                    val server =
                        CloudServer(
                            previous?.id ?: UUID.randomUUID().toString(),
                            login.origin,
                            result.getString("access_token"),
                            result.getString("refresh_token"),
                        )
                    receipt = server to previous
                    val context = currentCoroutineContext()
                    synchronized(lock) {
                        if (
                            token != epoch ||
                                !context.isActive ||
                                credentials.pending() != (if (callback == null) login else null)
                        )
                            throw CancellationException("Sign-in was cancelled")
                        credentials.save(server)
                        credentials.pending(null)
                    }
                    server
                }
            } catch (failure: Exception) {
                receipt?.let { (server, previous) ->
                    withContext(NonCancellable + Dispatchers.IO) {
                        synchronized(lock) {
                            if (credentials.servers().find { it.id == server.id } == server) {
                                if (previous == null) credentials.remove(server.id)
                                else credentials.save(previous)
                            }
                            if (attempt == epoch && credentials.pending() == ceremony)
                                credentials.pending(null)
                        }
                        runCatching {
                            CloudHttp.publicPost(
                                server.origin,
                                "/api/auth/logout",
                                JSONObject().put("refresh_token", server.refresh),
                            )
                        }
                    }
                }
                synchronized(lock) {
                    if (attempt != null && attempt != epoch)
                        throw CancellationException("Sign-in was cancelled")
                }
                throw failure
            }
        }
}
