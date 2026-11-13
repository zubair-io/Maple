package app.justmaple.aperture.cloud

import android.net.Uri
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/** PKCE callback codes redeem in one lane; only an active ceremony can commit. */
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

    private suspend fun exchange(callback: Uri): CloudServer? =
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
                            val login = credentials.pending() ?: return@withContext null
                            require(System.currentTimeMillis() - login.started in 0..600_000) {
                                "Sign-in expired. Please try again."
                            }
                            val code = login.validateCallback(callback)
                            ceremony = login
                            attempt = epoch
                            credentials.pending(null)
                            Triple(login, code, epoch)
                        }
                    val response = CloudHttp.publicPost(
                        login.origin,
                        "/api/auth/native-code/redeem",
                        JSONObject().put("code_verifier", login.verifier).put("code", code),
                    )
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
                                credentials.pending() != null
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
