package app.justmaple.aperture.ui

import androidx.compose.runtime.mutableStateMapOf
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.PhotoLibrary
import kotlinx.coroutines.*

internal data class FolderTreeEntry(val folder: Folder, val ancestors: List<Folder>) {
    val key
        get() = folder.uri.toString()

    val rowKey
        get() = (ancestors.map { it.uri.toString() } + key).joinToString("\n")
}

/** Activity-scoped, lazy folder listings shared by the pinned sidebar and drawer. */
internal class FolderTree(private val library: PhotoLibrary, private val scope: CoroutineScope) {
    val children = mutableStateMapOf<String, List<Folder>>()
    val expanded = mutableStateMapOf<String, Boolean>()
    val errors = mutableStateMapOf<String, String>()
    val loading = mutableStateMapOf<String, Boolean>()
    private val jobs = mutableMapOf<String, Job>()
    private var sources: List<Folder> = emptyList()

    fun syncSources(current: List<Folder>) {
        if (sources != current) {
            clear()
            sources = current
            current.filter { CloudLibrary.isCloud(it.uri) }.forEach(::load)
        }
    }

    fun load(folder: Folder) {
        val key = folder.uri.toString()
        if (children.containsKey(key) || loading[key] == true) return
        loading[key] = true
        errors.remove(key)
        val job =
            scope.launch(start = CoroutineStart.LAZY) {
                val owner = currentCoroutineContext().job
                try {
                    val folders = library.folders(folder.uri)
                    if (jobs[key] === owner) children[key] = folders
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    if (jobs[key] === owner)
                        errors[key] = failure.message ?: "Folder access is unavailable"
                } finally {
                    if (jobs[key] === owner) {
                        loading[key] = false
                        jobs.remove(key)
                    }
                }
            }
        jobs[key] = job
        job.start()
    }

    fun seed(folder: Folder, folders: List<Folder>) {
        val key = folder.uri.toString()
        jobs.remove(key)?.cancel()
        children[key] = folders.filter { it.name != ".." }
        loading[key] = false
        errors.remove(key)
    }

    fun reveal(trail: List<Folder>) {
        trail.dropLast(1).forEach { folder ->
            expanded[folder.uri.toString()] = true
            load(folder)
        }
    }

    fun toggle(folder: Folder) {
        val key = folder.uri.toString()
        val open = expanded[key] != true
        expanded[key] = open
        if (open) load(folder)
    }

    fun open(folder: Folder) {
        expanded[folder.uri.toString()] = true
        load(folder)
    }

    fun entries(roots: List<Folder>, ancestors: List<Folder> = emptyList()): List<FolderTreeEntry> =
        buildList {
            fun append(folder: Folder, path: List<Folder>) {
                if (path.any { it.uri == folder.uri }) return
                add(FolderTreeEntry(folder, path))
                if (expanded[folder.uri.toString()] == true)
                    children[folder.uri.toString()].orEmpty().forEach { append(it, path + folder) }
            }
            roots.forEach { append(it, ancestors) }
        }

    fun clear() {
        jobs.values.toList().forEach { it.cancel() }
        jobs.clear()
        children.clear()
        expanded.clear()
        errors.clear()
        loading.clear()
    }
}
