package app.justmaple.aperture

import android.content.Intent
import android.util.Base64
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.*
import java.io.File
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class CloudCredentialRecoveryTest {
    @Test
    fun unreadableCredentialsPermitStartupAndFreshConnections() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.getSharedPreferences("maple-cloud", 0)
        val credentials = CloudCredentials(context)
        val server =
            CloudServer("recovery", "http://127.0.0.1:1", "access-fixture", "refresh-fixture")
        for (name in listOf("servers", "pending")) {
            for (corruption in 0..2) {
                preferences.edit().clear().commit()
                if (name == "servers") credentials.save(server)
                else credentials.pending(CloudLogin.create(server.origin))
                val encrypted = preferences.getString(name, null)!!
                val damaged =
                    when (corruption) {
                        0 -> "!invalid-base64!"
                        1 -> encrypted.take(4)
                        else ->
                            Base64.encodeToString(
                                Base64.decode(encrypted, Base64.NO_WRAP).apply {
                                    this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte()
                                },
                                Base64.NO_WRAP,
                            )
                    }
                preferences.edit().putString(name, damaged).commit()
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java))
                    .use { scenario ->
                        assertEquals(androidx.lifecycle.Lifecycle.State.RESUMED, scenario.state)
                        assertFalse(preferences.contains(name))
                    }
                credentials.save(server)
                assertEquals(listOf(server), CloudCredentials(context).servers())
            }
        }
        preferences.edit().clear().commit()
        credentials.save(server)
        credentials.pending(CloudLogin.create(server.origin))
        KeyStore.getInstance("AndroidKeyStore")
            .apply { load(null) }
            .deleteEntry(CloudCredentials.KEY)
        assertTrue(credentials.servers().isEmpty())
        assertNull(credentials.pending())
        assertFalse(preferences.contains("servers"))
        assertFalse(preferences.contains("pending"))
        credentials.save(server)
        assertEquals(listOf(server), CloudCredentials(context).servers())
        preferences.edit().clear().commit()
    }

    @Test
    fun slowLogoutDoesNotBlockAnotherServersRefresh() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val credentials = CloudCredentials(context)
        val firstDirectory =
            File(context.cacheDir, "logout-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        val secondDirectory =
            File(context.cacheDir, "refresh-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        FileCloudServer(firstDirectory).use { first ->
            FileCloudServer(secondDirectory).use { second ->
                credentials.save(
                    CloudServer(
                        "logout-first",
                        first.origin,
                        "fixture-access-1",
                        "fixture-refresh-1",
                    )
                )
                credentials.save(
                    CloudServer(
                        "refresh-second",
                        second.origin,
                        "fixture-access-1",
                        "fixture-refresh-1",
                    )
                )
                val http = CloudHttp(credentials)
                val release = CountDownLatch(1)
                val executor = Executors.newFixedThreadPool(2)
                first.releaseLogout = release
                try {
                    val logout = executor.submit { http.disconnect("logout-first") }
                    assertTrue(first.logoutEntered.await(10, TimeUnit.SECONDS))
                    second.forceRefresh = true
                    val refreshed = executor.submit {
                        http.request("refresh-second", "/api/folders").requireSuccess()
                    }
                    refreshed.get(5, TimeUnit.SECONDS)
                    assertEquals(1, second.refreshCount)
                    assertTrue(credentials.servers().none { it.id == "logout-first" })
                    assertTrue(credentials.servers().any { it.id == "refresh-second" })
                    release.countDown()
                    logout.get(10, TimeUnit.SECONDS)
                } finally {
                    release.countDown()
                    executor.shutdownNow()
                    credentials.remove("logout-first")
                    credentials.remove("refresh-second")
                }
            }
        }
        firstDirectory.deleteRecursively()
        secondDirectory.deleteRecursively()
    }
}
