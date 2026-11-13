package app.justmaple.aperture.documents

import android.content.SharedPreferences
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Follows `GET /api/changes` for servers the system is actively browsing. Polling starts
 * on provider use and stops after [idleMillis] without any, so background work is bounded.
 * A 409 resumes from the server's `current` cursor (never 0, which loops on a busy server)
 * and invalidates everything for that server, as the Apple File Provider does.
 */
internal class CloudChangeFeed(
    private val changes: (server: String, since: Long, limit: Int) -> CloudChangePage,
    private val preferences: SharedPreferences,
    private val listener: Listener,
    private val intervalMillis: Long = 5_000L,
    private val idleMillis: Long = 10 * 60_000L,
) {
    interface Listener {
        fun changed(server: String, changes: List<CloudChange>)

        fun expired(server: String)

        fun polled(server: String)
    }

    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "maple-documents-changes").apply { isDaemon = true }
        }
    private val active = mutableMapOf<String, Long>()
    private val running = mutableSetOf<String>()

    fun touch(server: String) {
        val start =
            synchronized(active) {
                active[server] = System.currentTimeMillis()
                running.add(server)
            }
        if (start) scheduler.execute { poll(server) }
    }

    fun forget(server: String) =
        synchronized(active) {
            active.remove(server)
            preferences.edit().remove(key(server)).apply()
        }

    private fun poll(server: String) {
        val stop =
            synchronized(active) {
                val last = active[server]
                val idle = last == null || System.currentTimeMillis() - last > idleMillis
                if (idle) {
                    active.remove(server)
                    running.remove(server)
                }
                idle
            }
        if (stop) return
        try {
            sync(server)
        } catch (failure: Exception) {
            // Offline or signed out: listings report their own errors; keep the cursor.
            Log.w("Maple", "Maple Cloud change feed unavailable", failure)
        }
        listener.polled(server)
        scheduler.schedule({ poll(server) }, intervalMillis, TimeUnit.MILLISECONDS)
    }

    /** A forgotten (signed-out) server never gets its cursor written back by a late page. */
    private fun persist(server: String, cursor: Long) =
        synchronized(active) {
            if (server in active) preferences.edit().putLong(key(server), cursor).apply()
        }

    private fun sync(server: String) {
        val stored = preferences.getLong(key(server), -1L)
        if (stored < 0) {
            persist(server, establish(server))
            return
        }
        var cursor = stored
        repeat(MAX_PAGES) {
            when (val page = changes(server, cursor, PAGE)) {
                is CloudChangePage.Expired -> {
                    persist(server, page.current)
                    listener.expired(server)
                    return
                }
                is CloudChangePage.Rows -> {
                    if (page.changes.isNotEmpty()) listener.changed(server, page.changes)
                    cursor = page.next ?: cursor
                    persist(server, cursor)
                    if (page.changes.size < PAGE) return
                }
            }
        }
    }

    /** A first sync adopts the journal head without replaying history as notifications. */
    private fun establish(server: String): Long {
        var cursor = 0L
        while (true) {
            when (val page = changes(server, cursor, ESTABLISH_PAGE)) {
                is CloudChangePage.Expired -> return page.current
                is CloudChangePage.Rows -> {
                    cursor = page.next ?: return cursor
                    if (page.changes.size < ESTABLISH_PAGE) return cursor
                }
            }
        }
    }

    private fun key(server: String) = "changes.cursor.$server"

    companion object {
        private const val PAGE = 500
        private const val ESTABLISH_PAGE = 1000
        private const val MAX_PAGES = 20
    }
}
