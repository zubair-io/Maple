package app.justmaple.aperture.cloud

import android.os.SystemClock
import org.json.JSONObject

internal data class CloudStackConfig(
    val pairOpsSupported: Boolean = false,
    val stackRawJpeg: Boolean = true,
) {
    val fold: Boolean get() = pairOpsSupported && stackRawJpeg
}

internal class CloudStackPolicy(
    private val fetch: (String, String) -> CloudResponse,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) {
    private data class Cached(val config: CloudStackConfig, val expires: Long)
    private val servers = mutableMapOf<String, Cached>()

    @Synchronized
    fun config(server: String): CloudStackConfig {
        val time = now()
        servers[server]?.takeIf { time < it.expires }?.let { return it.config }
        val response = fetch(server, "/api/display/config")
        val config = when (response.status) {
            404, 405 -> CloudStackConfig()
            else -> JSONObject(response.requireSuccess().text()).let {
                CloudStackConfig(
                    pairOpsSupported = it.opt("stack_pair_ops_supported") == true,
                    stackRawJpeg = it.opt("stack_raw_jpeg") != false,
                )
            }
        }
        servers[server] = Cached(config, time + 30_000)
        return config
    }

    @Synchronized
    fun invalidate(server: String) {
        servers.remove(server)
    }
}
