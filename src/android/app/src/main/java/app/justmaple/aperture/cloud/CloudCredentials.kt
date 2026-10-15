package app.justmaple.aperture.cloud

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

internal data class CloudServer(
    val id: String,
    val origin: String,
    val access: String,
    val refresh: String,
)

internal data class CloudLogin(
    val origin: String,
    val verifier: String,
    val state: String,
    val started: Long,
) {
    fun browserUri(): Uri =
        Uri.parse(origin)
            .buildUpon()
            .appendQueryParameter("native_callback", "maple-app")
            .appendQueryParameter("code_challenge", challenge(verifier))
            .appendQueryParameter("state", state)
            .build()

    fun validateCallback(uri: Uri): String {
        require(
            uri.scheme == "maple-app" && uri.host == "auth-success" && uri.path.orEmpty().isEmpty()
        ) {
            "Invalid sign-in callback"
        }
        require(
            uri.getQueryParameters("state").size == 1 && uri.getQueryParameter("state") == state
        ) {
            "Sign-in state did not match. Please try again."
        }
        require(System.currentTimeMillis() - started in 0..600_000) {
            "Sign-in expired. Please try again."
        }
        require(uri.getQueryParameters("code").size == 1) {
            "Sign-in callback is missing its one-time code"
        }
        return uri.getQueryParameter("code")!!.also { require(it.isNotBlank()) }
    }

    companion object {
        fun create(input: String): CloudLogin =
            CloudLogin(origin(input), random(), random(), System.currentTimeMillis())

        fun origin(input: String): String {
            val value = input.trim().let { if (it.contains("://")) it else "https://$it" }
            val uri = URI(value)
            require(
                !uri.host.isNullOrBlank() &&
                    uri.rawUserInfo == null &&
                    uri.rawQuery == null &&
                    uri.rawFragment == null &&
                    uri.path.orEmpty() in setOf("", "/")
            ) {
                "Enter a server domain without a path, query, or credentials"
            }
            val scheme = uri.scheme?.lowercase()
            require(
                scheme == "https" ||
                    (scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "10.0.2.2"))
            ) {
                "Use the server's HTTPS address"
            }
            return URI(scheme, null, uri.host.lowercase(), uri.port, null, null, null)
                .toASCIIString()
        }

        fun challenge(verifier: String): String =
            encode(
                MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
            )

        private fun random(): String = encode(ByteArray(32).also { SecureRandom().nextBytes(it) })

        private fun encode(value: ByteArray) =
            Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }
}

/** Tokens and pending PKCE secrets are encrypted by a non-exportable device key. */
internal class CloudCredentials(context: Context) {
    private val preferences = context.getSharedPreferences("maple-cloud", Context.MODE_PRIVATE)
    private val key: SecretKey by lazy {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY, null) as? SecretKey)
            ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                KEY,
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }

    @Synchronized
    fun servers(): List<CloudServer> {
        val list = JSONArray(read("servers") ?: "[]")
        return (0 until list.length()).map { index ->
            val item = list.getJSONObject(index)
            CloudServer(
                item.getString("id"),
                item.getString("origin"),
                item.getString("access"),
                item.getString("refresh"),
            )
        }
    }

    @Synchronized
    fun save(server: CloudServer) {
        write(
            "servers",
            JSONArray()
                .apply {
                    (servers().filter { it.id != server.id } + server).forEach {
                        put(
                            JSONObject()
                                .put("id", it.id)
                                .put("origin", it.origin)
                                .put("access", it.access)
                                .put("refresh", it.refresh)
                        )
                    }
                }
                .toString(),
        )
    }

    @Synchronized
    fun remove(id: String) {
        write(
            "servers",
            JSONArray()
                .apply {
                    servers()
                        .filter { it.id != id }
                        .forEach {
                            put(
                                JSONObject()
                                    .put("id", it.id)
                                    .put("origin", it.origin)
                                    .put("access", it.access)
                                    .put("refresh", it.refresh)
                            )
                        }
                }
                .toString(),
        )
    }

    @Synchronized
    fun pending(): CloudLogin? =
        read("pending")?.let {
            val value = JSONObject(it)
            CloudLogin(
                value.getString("origin"),
                value.getString("verifier"),
                value.getString("state"),
                value.getLong("started"),
            )
        }

    @Synchronized
    fun pending(login: CloudLogin?) {
        if (login == null) check(preferences.edit().remove("pending").commit())
        else
            write(
                "pending",
                JSONObject()
                    .put("origin", login.origin)
                    .put("verifier", login.verifier)
                    .put("state", login.state)
                    .put("started", login.started)
                    .toString(),
            )
    }

    private fun write(name: String, value: String) {
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        check(
            preferences
                .edit()
                .putString(name, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .commit()
        ) {
            "Could not store cloud credentials"
        }
    }

    private fun read(name: String): String? =
        preferences.getString(name, null)?.let {
            val bytes = Base64.decode(it, Base64.NO_WRAP)
            val cipher =
                Cipher.getInstance("AES/GCM/NoPadding").apply {
                    init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                }
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        }

    companion object {
        private const val KEY = "maple-cloud-credentials-v1"
    }
}
