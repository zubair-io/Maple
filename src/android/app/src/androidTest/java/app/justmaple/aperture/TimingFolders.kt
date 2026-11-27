package app.justmaple.aperture

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.util.Base64
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import java.io.File

internal class TimingFolders(val fixture: CacheProviderFixture = CacheProviderFixture()) {
    private val context = fixture.context
    val directory = File(context.cacheDir, "cache-provider-fixtures")
    val tree: Uri = DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root")

    fun populate(name: String, count: Int): File {
        val folder = if (name.isEmpty()) directory else File(directory, name).apply { mkdirs() }
        val bytes = fixture.asset("source.dng")
        val modified = System.currentTimeMillis() - 3_600_000
        for (index in 1..count) {
            File(folder, "IMG_%05d.dng".format(index)).apply {
                writeBytes(bytes)
                setLastModified(modified)
            }
        }
        return folder
    }

    fun subtree(name: String): Uri = DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root/$name")

    fun counters(): Counters {
        val state = checkNotNull(fixture.call("cache-test-state"))
        return Counters(
            state.getInt("childQueries"),
            state.getInt("childRows"),
            state.getInt("documentQueries"),
            state.getInt("sidecarReads"),
            state.getStringArrayList("queriesByParent").orEmpty().associate {
                it.substringBeforeLast('=') to it.substringAfterLast('=').toInt()
            },
        )
    }

    data class Counters(
        val childQueries: Int,
        val childRows: Int,
        val documentQueries: Int,
        val sidecarReads: Int,
        val byParent: Map<String, Int>,
    ) {
        operator fun minus(other: Counters) =
            Counters(
                childQueries - other.childQueries,
                childRows - other.childRows,
                documentQueries - other.documentQueries,
                sidecarReads - other.sidecarReads,
                byParent.mapValues { it.value - (other.byParent[it.key] ?: 0) }.filterValues { it != 0 },
            )
    }

    companion object {
        const val AUTHORITY = "app.justmaple.aperture.test.cache-documents"
    }
}

internal object TimingSources {
    private val FAKE_ACCESS = listOf("{}", """{"sub":"timing"}""", "sig").joinToString(".") { part ->
        Base64.encodeToString(part.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }
    private const val LIBRARY = "maple-library"
    private const val CLOUD = "maple-cloud"
    private const val BACKUP = "maple-timing-sources-backup"
    private const val SOURCES = "sources"
    private const val SERVERS = "servers"
    const val CLOUD_ID = "timing-cloud-server"

    private fun preferences(context: Context, name: String) =
        context.getSharedPreferences(name, Context.MODE_PRIVATE)

    /**
     * Keeps the app's own saved folders and the still-encrypted cloud sign-ins in a separate file, once:
     * a second call while a backup exists changes nothing, so a run that was killed before [restore]
     * cannot make the next run back up its own timing configuration.
     */
    fun backUp(context: Context) {
        val backup = preferences(context, BACKUP)
        if (backup.getBoolean("present", false)) return
        val edit = backup.edit().putBoolean("present", true)
        preferences(context, LIBRARY).getStringSet(SOURCES, null)?.let { edit.putStringSet(SOURCES, it) }
        preferences(context, CLOUD).getString(SERVERS, null)?.let { edit.putString(SERVERS, it) }
        check(edit.commit())
    }

    fun restore(context: Context) {
        val backup = preferences(context, BACKUP)
        if (!backup.getBoolean("present", false)) return
        val library = preferences(context, LIBRARY).edit()
        backup.getStringSet(SOURCES, null)?.let { library.putStringSet(SOURCES, it) } ?: library.remove(SOURCES)
        check(library.commit())
        val cloud = preferences(context, CLOUD).edit()
        backup.getString(SERVERS, null)?.let { cloud.putString(SERVERS, it) } ?: cloud.remove(SERVERS)
        check(cloud.commit())
        check(backup.edit().clear().commit())
    }

    fun set(context: Context, trees: List<Uri>, cloud: Boolean) {
        backUp(context)
        check(
            preferences(context, LIBRARY)
                .edit()
                .putStringSet(SOURCES, trees.map { it.toString() }.toSet())
                .commit()
        )
        val credentials = CloudCredentials(context)
        credentials.servers().forEach { credentials.remove(it.id) }
        if (cloud)
            credentials.save(CloudServer(CLOUD_ID, "https://timing.invalid", FAKE_ACCESS, "refresh"))
    }
}

internal fun Bundle.describe() = keySet().joinToString { "$it=${get(it)}" }
