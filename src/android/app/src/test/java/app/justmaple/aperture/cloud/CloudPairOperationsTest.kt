package app.justmaple.aperture.cloud

import android.net.Uri
import android.os.CancellationSignal
import app.justmaple.aperture.data.Photo
import java.io.File
import java.io.OutputStream
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudPairOperationsTest {
    private fun response(status: Int, json: String = "{}") =
        CloudResponse(status, json.toByteArray(), null, null)

    private class Transport : CloudTransport {
        data class Call(val server: String, val path: String, val method: String, val body: JSONObject?)
        val calls = mutableListOf<Call>()
        var respond: (Call) -> CloudResponse = { CloudResponse(200, "{}".toByteArray(), null, null) }
        override fun request(id: String, path: String, method: String, body: String?, headers: Map<String, String>): CloudResponse {
            val call = Call(id, path, method, body?.let(::JSONObject))
            calls += call
            return respond(call)
        }
        override fun request(id: String, path: String, method: String, body: String?, headers: Map<String, String>, account: String): CloudResponse = error("Unexpected account-bound request")
        override fun download(id: String, path: String, output: OutputStream, signal: CancellationSignal?) = error("Unexpected download")
        override fun upload(id: String, path: String, file: File, headers: Map<String, String>, account: String): CloudResponse = error("Unexpected upload")
    }

    private fun photo(name: String, id: String?) = Photo(
        CloudLibrary.address("server", "photos:Trip/$name", "/srv/photos/Trip/$name"),
        name, 200, 1234, null, assetId = id,
    )
    private val jpeg get() = photo("IMG_1.JPG", "jpeg")
    private val pair get() = photo("IMG_1.CR3", "raw").copy(companion = jpeg)

    @Test fun featureDetectionRequiresAnExplicitCapabilityAndHonorsTheDisplayPreference() {
        for ((json, folds) in listOf(
            "{}" to false,
            "{\"stack_raw_jpeg\":true}" to false,
            "{\"stack_pair_ops_supported\":\"true\"}" to false,
            "{\"stack_pair_ops_supported\":true}" to true,
            "{\"stack_pair_ops_supported\":true,\"stack_raw_jpeg\":false}" to false,
        )) assertEquals(json, folds, CloudStackPolicy({ _, _ -> response(200, json) }).config("server").fold)
        for (status in listOf(404, 405))
            assertFalse(CloudStackPolicy({ _, _ -> response(status) }).config("old").fold)
    }

    @Test fun configurationIsCachedPerServerAndExpiresAndInvalidates() {
        var clock = 10L
        val requests = mutableListOf<String>()
        val policy = CloudStackPolicy({ server, path ->
            assertEquals("/api/display/config", path)
            requests += server
            response(200, "{\"stack_pair_ops_supported\":true}")
        }, { clock })
        assertTrue(policy.config("a").fold)
        policy.config("a")
        policy.config("b")
        assertEquals(listOf("a", "b"), requests)
        clock += 30_000
        policy.config("a")
        policy.invalidate("b")
        policy.config("b")
        assertEquals(listOf("a", "b", "a", "b"), requests)
    }

    @Test fun failedDetectionDoesNotCacheSupportOrSendAFileWrite() {
        val http = Transport()
        var fail = true
        val policy = CloudStackPolicy({ _, _ -> response(if (fail) 503 else 200, "{\"stack_pair_ops_supported\":true}") })
        val ops = CloudPairOperations(http, policy)
        assertThrows(CloudStatusException::class.java) { ops.rename(pair, "Trip.CR3") }
        assertTrue(http.calls.isEmpty())
        fail = false
        ops.rename(pair, "Trip.CR3")
        assertEquals(1, http.calls.size)
    }

    @Test fun renameMoveCopyAndTrashCarryTheCompanionInOneRequest() {
        val http = Transport()
        val policy = CloudStackPolicy({ _, _ -> response(200, "{\"stack_pair_ops_supported\":true}") })
        val ops = CloudPairOperations(http, policy)
        ops.rename(pair, "Trip.CR3")
        ops.relocate(pair, "Elsewhere")
        ops.relocate(pair, "Copies", copy = true)
        http.respond = { response(204, "") }
        assertNull(ops.trash(pair))
        assertEquals(4, http.calls.size)
        for (call in http.calls.take(3)) {
            assertEquals("server", call.server)
            assertEquals("POST", call.method)
            assertEquals("jpeg", call.body!!.getString("companion_id"))
            assertEquals("skip", call.body.getString("companion_collision"))
            assertEquals("skip", call.body.getString("collision"))
            assertEquals("photos:Trip/IMG_1.CR3", call.body.getString("source_address"))
        }
        assertEquals("/api/assets/raw/rename", http.calls[0].path)
        assertEquals("Trip.CR3", http.calls[0].body!!.getString("new_filename"))
        assertEquals("/api/assets/raw/relocate", http.calls[1].path)
        assertEquals("move", http.calls[1].body!!.getString("mode"))
        assertEquals("Elsewhere", http.calls[1].body!!.getString("destination_path"))
        assertEquals("copy", http.calls[2].body!!.getString("mode"))
        assertEquals("DELETE", http.calls[3].method)
        assertEquals("/api/assets/raw?intent=trash&companion=jpeg", http.calls[3].path)
    }

    @Test fun foldedWritesRefuseOlderServersBeforeEitherFileChangesEvenWhenPreferenceIsOff() {
        for (operation in listOf<(CloudPairOperations) -> Unit>(
            { it.rename(pair, "Trip.CR3") }, { it.relocate(pair, "Other") },
            { it.relocate(pair, "Other", copy = true) }, { it.trash(pair) },
        )) {
            val http = Transport()
            val ops = CloudPairOperations(http, CloudStackPolicy({ _, _ -> response(200, "{}") }))
            val failure = assertThrows(IllegalStateException::class.java) { operation(ops) }
            assertTrue(failure.message!!.contains("Upgrade the server"))
            assertTrue(http.calls.isEmpty())
        }
        val http = Transport()
        val ops = CloudPairOperations(http, CloudStackPolicy({ _, _ -> response(200,
            "{\"stack_pair_ops_supported\":true,\"stack_raw_jpeg\":false}") }))
        ops.rename(pair, "Trip.CR3")
        assertEquals("jpeg", http.calls.single().body!!.getString("companion_id"))
    }

    @Test fun unindexedMembersResolveByAddressButNeverFallBackToARawOnlyWrite() {
        val http = Transport()
        http.respond = { call ->
            when {
                call.path.endsWith("IMG_1.CR3") -> response(200, "{\"id\":\"raw\"}")
                call.path.endsWith("IMG_1.JPG") -> response(404)
                else -> error("Unexpected file write")
            }
        }
        val ops = CloudPairOperations(http, CloudStackPolicy({ _, _ -> response(200, "{\"stack_pair_ops_supported\":true}") }))
        val unindexed = pair.copy(assetId = null, companion = jpeg.copy(assetId = null))
        val failure = assertThrows(IllegalStateException::class.java) { ops.rename(unindexed, "Trip.CR3") }
        assertTrue(failure.message!!.contains("indexing IMG_1.JPG"))
        assertEquals(listOf("GET", "GET"), http.calls.map { it.method })
    }

    @Test fun collisionsAndMissingCompanionsRemainVisibleFailures() {
        val http = Transport()
        val ops = CloudPairOperations(http, CloudStackPolicy({ _, _ -> response(200, "{\"stack_pair_ops_supported\":true}") }))
        http.respond = { response(200, "{\"skipped\":true,\"collision_filename\":\"Trip.JPG\"}") }
        assertTrue(assertThrows(IllegalStateException::class.java) { ops.rename(pair, "Trip.CR3") }.message!!.contains("Trip.JPG"))
        http.respond = { response(404, "{\"missing\":\"companion\"}") }
        assertTrue(assertThrows(IllegalStateException::class.java) { ops.trash(pair) }.message!!.contains("IMG_1.JPG"))
        assertEquals(2, http.calls.size)
    }

    @Test fun unfoldedWritesKeepTheSingleFileContractOnOlderServers() {
        val http = Transport()
        val ops = CloudPairOperations(http, CloudStackPolicy({ _, _ -> error("Unfolded writes need no pair capability") }))
        ops.rename(pair.copy(companion = null), "Trip.CR3")
        assertFalse(http.calls.single().body!!.has("companion_id"))
        assertFalse(http.calls.single().body!!.has("companion_collision"))
    }
}
