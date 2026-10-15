package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudLibrary
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CloudSignInTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun browserSessionCanCompleteByPkceClaimWithoutACustomSchemeCallback() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "claim-${UUID.randomUUID()}").apply { mkdirs() }
        FileCloudServer(directory).use { server ->
            val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
            var browser: Uri? = null
            server.claimTransientStatus = 429
            compose.runOnIdle {
                browser = model.beginCloud(server.origin)!!
                server.expectedChallenge = browser!!.getQueryParameter("code_challenge")!!
                server.expectedState = browser!!.getQueryParameter("state")!!
            }
            compose.waitUntil(30_000) { server.claimCount >= 2 }
            assertTrue(model.state.value.cloudSigningIn)
            assertNull(model.state.value.error)
            server.claimReady = true
            compose.waitUntil(30_000) {
                !model.state.value.cloudSigningIn &&
                    model.state.value.folders.any { it.name == "Fixture photos" }
            }
            assertNull(model.state.value.error)
            val source =
                model.state.value.sources.single { it.name == Uri.parse(server.origin).authority }
            try {
                assertTrue(CloudLibrary(context).sources.any { it.uri == source.uri })
                // A browser may deliver its scheme callback after polling won the race.
                val late =
                    Uri.parse("maple-app://auth-success")
                        .buildUpon()
                        .appendQueryParameter("state", browser!!.getQueryParameter("state"))
                        .appendQueryParameter("code", "fixture-code")
                        .build()
                compose.runOnIdle { model.completeCloud(late) }
                compose.waitForIdle()
                assertNull(model.state.value.error)
                assertFalse(model.state.value.cloudSigningIn)
            } finally {
                runBlocking { model.library.cloud.disconnect(source) }
            }
        }
        directory.deleteRecursively()
    }

    @Test
    fun coroutineCancellationDuringRedemptionRevokesTokensWithoutPersistingAConnection() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory =
            File(context.cacheDir, "cancelled-redeem-${UUID.randomUUID()}").apply { mkdirs() }
        FileCloudServer(directory).use { server ->
            val cloud = CloudLibrary(context)
            val browser = cloud.begin(server.origin)
            server.expectedChallenge = browser.getQueryParameter("code_challenge")!!
            val callback =
                Uri.parse("maple-app://auth-success")
                    .buildUpon()
                    .appendQueryParameter("state", browser.getQueryParameter("state"))
                    .appendQueryParameter("code", "fixture-code")
                    .build()
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            server.redeemEntered = entered
            server.releaseRedeem = release
            runBlocking {
                val redeem = launch(Dispatchers.Default) { cloud.complete(callback) }
                try {
                    assertTrue(entered.await(10, TimeUnit.SECONDS))
                    // Activity/ViewModel teardown cancels the job without cancelLogin().
                    redeem.cancel()
                } finally {
                    release.countDown()
                }
                redeem.join()
            }
            assertTrue(
                "An unpublished session must be revoked",
                server.logoutEntered.await(10, TimeUnit.SECONDS),
            )
            assertFalse(cloud.signingIn)
            assertTrue(cloud.sources.none { it.name == Uri.parse(server.origin).authority })
            assertTrue(
                CloudLibrary(context).sources.none { it.name == Uri.parse(server.origin).authority }
            )
        }
        directory.deleteRecursively()
    }
}
