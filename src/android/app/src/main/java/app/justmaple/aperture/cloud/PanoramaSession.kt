package app.justmaple.aperture.cloud

import android.net.Uri
import app.justmaple.aperture.data.LibraryListing
import app.justmaple.aperture.data.Photo
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** The selected server inputs a preview or stitch was made for, bound to the signed-in account. */
data class PanoInputs(val server: String, val account: String, val paths: List<String>)

sealed interface PanoConfigState {
    data object Loading : PanoConfigState
    data class Ready(val capabilities: PanoCapabilities, val libraryId: String) : PanoConfigState
    data class Failed(val message: String) : PanoConfigState
}

sealed interface PanoPreviewRun {
    data object Idle : PanoPreviewRun
    data class Running(val progress: PanoProgress?) : PanoPreviewRun
    data class Failed(val code: String, val message: String) : PanoPreviewRun
}

/** A finished `pano_preview` job: its uncropped PNG, canvas and server-ordered frames. */
class PanoPreviewImage(
    val jobId: String,
    val png: ByteArray,
    val width: Int,
    val height: Int,
    val frames: List<PanoFrame>,
    val inputs: PanoInputs,
    val options: PanoOptions,
    val matcherNote: String?,
)

sealed interface PanoStitchRun {
    data object Idle : PanoStitchRun
    /** Cancelling here waits for the job id, so the server cancels exactly that job. */
    data class Submitting(val cancelRequested: Boolean = false) : PanoStitchRun
    data class Running(val jobId: String, val progress: PanoProgress?, val cancelRequested: Boolean) : PanoStitchRun
    data class Done(val job: PanoJob) : PanoStitchRun
    /** [jobId] names a job still on the server whose status could not be read. */
    data class Failed(val code: String, val message: String, val jobId: String? = null) : PanoStitchRun
    data object Cancelled : PanoStitchRun
}

data class PanoramaState(
    val inputs: PanoInputs? = null,
    val photos: List<Photo> = emptyList(),
    val config: PanoConfigState = PanoConfigState.Loading,
    val options: PanoOptions = PanoOptions(),
    val preview: PanoPreviewRun = PanoPreviewRun.Idle,
    val image: PanoPreviewImage? = null,
    val stitch: PanoStitchRun = PanoStitchRun.Idle,
    val outputError: String? = null,
) {
    val open: Boolean
        get() = inputs != null

    val stitching: Boolean
        get() = stitch is PanoStitchRun.Submitting || stitch is PanoStitchRun.Running

    val capabilities: PanoCapabilities?
        get() = (config as? PanoConfigState.Ready)?.capabilities

    /** The shown preview was made for exactly these inputs and options and nothing newer is running. */
    val previewCurrent: Boolean
        get() = image != null && image.inputs == inputs && image.options == options &&
            preview !is PanoPreviewRun.Running
}

/**
 * The server-backed merge flow for one Browse selection (#5994): read the server's capabilities,
 * keep a debounced quick preview current for the options, then queue the full stitch and follow
 * it to its output asset. Android never stitches or solves alignment; it forwards the finished
 * preview's job id so the server can reuse that alignment.
 *
 * Owned by the activity's view model, so recreation keeps following the same jobs. Every
 * publication checks its generation and the signed-in account, so a superseded request, a closed
 * sheet or an account change never shows a stale job.
 */
internal class PanoramaSession(
    private val scope: CoroutineScope,
    private val client: PanoramaClient,
    private val account: (server: String) -> String?,
    private val listFolder: suspend (Uri) -> LibraryListing,
    private val io: CoroutineContext = Dispatchers.IO,
) {
    private val mutable = MutableStateFlow(PanoramaState())
    val state: StateFlow<PanoramaState> = mutable.asStateFlow()
    private var session = 0
    private var previewGeneration = 0
    private var stitchGeneration = 0
    private var configJob: Job? = null
    private var previewJob: Job? = null
    private var stitchJob: Job? = null
    private var previewInFlight: String? = null
    private val previewPost = Mutex()

    /** Starts merging [photos], or says why they cannot be merged. */
    fun open(photos: List<Photo>): String? {
        val refusal = refusal(photos)
        if (refusal != null) return refusal
        val server = photos.first().uri.host!!
        val signedIn = account(server) ?: return "This server is no longer connected."
        close()
        val paths = photos.map { it.uri.getQueryParameter("path")!! }.distinct().sorted()
        val opened = ++session
        mutable.value = PanoramaState(PanoInputs(server, signedIn, paths), photos)
        configJob = scope.launch {
            try {
                val capabilities = withContext(io) { client.capabilities(server, signedIn) }
                val libraryId = withContext(io) { libraryFor(server, signedIn, photos, paths.first()) }
                publish(opened) { it.copy(config = PanoConfigState.Ready(capabilities, libraryId)) }
                if (opened == session) requestPreview()
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                publish(opened) { it.copy(config = PanoConfigState.Failed(message(failure, "Could not read this server's panorama settings."))) }
            }
        }
        return null
    }

    fun setOptions(options: PanoOptions) {
        if (!state.value.open || state.value.stitching || options == state.value.options) return
        mutable.value = state.value.copy(options = options)
        requestPreview()
    }

    fun retryPreview() = requestPreview()

    /** Stops the running preview, server job included; a finished preview stays shown. */
    fun cancelPreview() {
        ++previewGeneration
        previewJob?.cancel()
        previewJob = null
        val inputs = state.value.inputs
        previewInFlight?.let { id -> if (inputs != null) cancelOnServer(inputs, id) }
        previewInFlight = null
        if (state.value.preview is PanoPreviewRun.Running) mutable.value = state.value.copy(preview = PanoPreviewRun.Idle)
    }

    fun stitch() {
        val current = state.value
        val inputs = current.inputs ?: return
        val ready = current.config as? PanoConfigState.Ready ?: return
        if (!ready.capabilities.ready || current.stitching) return
        if ((current.stitch as? PanoStitchRun.Failed)?.jobId != null) return retryStitch()
        val alignmentFrom = current.image?.takeIf { it.inputs == inputs }?.jobId
        cancelPreview()
        val generation = ++stitchGeneration
        val opened = session
        mutable.value = state.value.copy(stitch = PanoStitchRun.Submitting(), outputError = null)
        val request = PanoRequest(inputs.paths, ready.libraryId, current.options, ready.capabilities, alignmentFrom)
        stitchJob = scope.launch {
            val id =
                try {
                    withContext(io + NonCancellable) {
                        client.stitch(inputs.server, inputs.account, request).also { id ->
                            if (generation != stitchGeneration || !current(opened, inputs)) cancelQuietly(inputs, id)
                        }
                    }
                } catch (failure: Exception) {
                    if (generation == stitchGeneration)
                        publish(opened) { it.copy(stitch = stitchFailure(failure)) }
                    return@launch
                }
            if (generation != stitchGeneration) return@launch
            val cancelling = (state.value.stitch as? PanoStitchRun.Submitting)?.cancelRequested == true
            val cancelFailure =
                if (!cancelling) null
                else withContext(io + NonCancellable) {
                    runCatching { client.cancel(inputs.server, inputs.account, id) }.exceptionOrNull()
                }
            publish(opened) {
                it.copy(
                    stitch = PanoStitchRun.Running(id, null, cancelling && cancelFailure == null),
                    outputError = cancelFailure?.let { failure -> failure.message?.takeIf(String::isNotBlank) ?: "Could not cancel the panorama." },
                )
            }
            follow(inputs, id, generation, opened)
        }
    }

    /** Asks the server to cancel the stitch and keeps following it until the job says so. */
    fun cancelStitch() {
        val inputs = state.value.inputs ?: return
        when (val run = state.value.stitch) {
            is PanoStitchRun.Submitting -> mutable.value = state.value.copy(stitch = run.copy(cancelRequested = true))
            is PanoStitchRun.Running -> {
                if (run.cancelRequested) return
                mutable.value = state.value.copy(stitch = run.copy(cancelRequested = true), outputError = null)
                val opened = session
                scope.launch {
                    try {
                        withContext(io) { client.cancel(inputs.server, inputs.account, run.jobId) }
                    } catch (failure: Exception) {
                        if (failure is CancellationException) throw failure
                        publish(opened) { state ->
                            val shown = state.stitch
                            if (shown is PanoStitchRun.Running && shown.jobId == run.jobId)
                                state.copy(stitch = shown.copy(cancelRequested = false), outputError = message(failure, "Could not cancel the panorama."))
                            else state
                        }
                    }
                }
            }
            else -> Unit
        }
    }

    /** Follows a job whose status could not be read again, or queues the stitch again. */
    fun retryStitch() {
        val current = state.value
        val inputs = current.inputs ?: return
        val failed = current.stitch as? PanoStitchRun.Failed
        val jobId = failed?.jobId
        if (jobId == null) {
            if (current.stitch is PanoStitchRun.Failed || current.stitch is PanoStitchRun.Cancelled) stitch()
            return
        }
        val generation = ++stitchGeneration
        val opened = session
        mutable.value = current.copy(stitch = PanoStitchRun.Running(jobId, null, false))
        stitchJob = scope.launch { follow(inputs, jobId, generation, opened) }
    }

    /** The stitched output as a library photo, with its folder's photos as the viewer's order. */
    suspend fun output(): Pair<Photo, List<Photo>>? {
        val current = state.value
        val inputs = current.inputs ?: return null
        val job = (current.stitch as? PanoStitchRun.Done)?.job ?: return null
        val opened = session
        return try {
            val path = job.outputPath ?: throw IOException("The server did not report where the panorama was written.")
            val library = withContext(io) { client.libraries(inputs.server, inputs.account) }
                .let { PanoramaWire.libraryHolding(it, path) }
                ?: throw IOException("The panorama was written outside this server's libraries.")
            val relative = path.removePrefix(library.path.trimEnd('/') + "/")
            val folder = CloudLibrary.address(inputs.server, "${library.slug}:${relative.substringBeforeLast('/', "")}", path.substringBeforeLast('/'))
            val listing = listFolder(folder)
            val photo = listing.photos.firstOrNull { it.uri.getQueryParameter("path") == path }
                ?: listing.photos.firstOrNull { it.name == path.substringAfterLast('/') }
                ?: throw IOException("The panorama is not in its library folder yet. Try again in a moment.")
            if (!current(opened, inputs)) null else photo to listing.photos
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            publish(opened) { it.copy(outputError = message(failure, "Could not open the panorama.")) }
            null
        }
    }

    /**
     * Ends the merge. A queued or running stitch nobody follows any more is cancelled on the
     * server, as the Web dialog does; one still being queued is cancelled when its id arrives.
     */
    fun close() {
        val inputs = state.value.inputs
        cancelPreview()
        ++stitchGeneration
        val unfinished = when (val run = state.value.stitch) {
            is PanoStitchRun.Running -> run.jobId
            is PanoStitchRun.Failed -> run.jobId
            else -> null
        }
        if (inputs != null && unfinished != null && account(inputs.server) == inputs.account)
            cancelOnServer(inputs, unfinished)
        drop()
    }

    /** Drops the merge without server calls when its account is no longer signed in. */
    fun connectionsChanged() {
        val inputs = state.value.inputs ?: return
        if (account(inputs.server) != inputs.account) drop()
    }

    private fun drop() {
        ++session
        ++previewGeneration
        ++stitchGeneration
        configJob?.cancel()
        previewJob?.cancel()
        stitchJob?.cancel()
        previewInFlight = null
        mutable.value = PanoramaState()
    }

    private fun requestPreview() {
        val current = state.value
        val inputs = current.inputs ?: return
        val ready = current.config as? PanoConfigState.Ready ?: return
        if (!ready.capabilities.ready || !ready.capabilities.preview || current.stitching) return
        val generation = ++previewGeneration
        val opened = session
        previewJob?.cancel()
        mutable.value = current.copy(preview = PanoPreviewRun.Running(null))
        previewJob = scope.launch {
            delay(PREVIEW_DEBOUNCE_MS)
            val shown = state.value
            val alignmentFrom = shown.image?.takeIf { it.inputs == inputs }?.jobId
            val request = PanoRequest(inputs.paths, ready.libraryId, shown.options, ready.capabilities, alignmentFrom)
            try {
                val id = postPreview(inputs, request, generation, opened) ?: return@launch
                followPreview(inputs, id, shown.options, generation, opened)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if (generation == previewGeneration) {
                    previewInFlight?.let { id -> cancelOnServer(inputs, id) }
                    previewInFlight = null
                    val refusal = failure as? PanoRefusal
                    publish(opened) {
                        it.copy(preview = PanoPreviewRun.Failed(refusal?.code.orEmpty(), previewMessage(failure)))
                    }
                }
            }
        }
    }

    /**
     * Posts one preview at a time, so the server supersedes them in request order. The post is not
     * torn down with its request: an id that arrives after a newer request is cancelled instead of
     * being lost with an aborted connection.
     */
    private suspend fun postPreview(inputs: PanoInputs, request: PanoRequest, generation: Int, opened: Int): String? =
        withContext(NonCancellable) {
            previewPost.withLock {
                if (generation != previewGeneration) return@withLock null
                val id = withContext(io) { client.preview(inputs.server, inputs.account, request) }
                if (generation != previewGeneration || !current(opened, inputs)) {
                    withContext(io) { cancelQuietly(inputs, id) }
                    null
                } else id.also { previewInFlight = it }
            }
        }

    private suspend fun followPreview(inputs: PanoInputs, id: String, options: PanoOptions, generation: Int, opened: Int) {
        while (true) {
            val job = withContext(io) { client.job(inputs.server, inputs.account, id) }
            if (generation != previewGeneration) return
            when (job.status) {
                PanoJobStatus.Queued, PanoJobStatus.Running ->
                    publish(opened) { it.copy(preview = PanoPreviewRun.Running(job.progress)) }
                PanoJobStatus.Done -> {
                    previewInFlight = null
                    val png = withContext(io) { client.previewPng(inputs.server, inputs.account, id) }
                    val width = job.width
                    val height = job.height
                    val image =
                        if (width == null || height == null || width <= 0 || height <= 0) null
                        else PanoPreviewImage(id, png, width, height, job.frames, inputs, options, job.matcherNote)
                    if (generation == previewGeneration)
                        publish(opened) {
                            if (image == null)
                                it.copy(preview = PanoPreviewRun.Failed("", "The server's preview has no dimensions."))
                            else it.copy(preview = PanoPreviewRun.Idle, image = image)
                        }
                    return
                }
                PanoJobStatus.Failed -> {
                    previewInFlight = null
                    publish(opened) { it.copy(preview = PanoPreviewRun.Failed("", job.error ?: "Preview failed.")) }
                    return
                }
                PanoJobStatus.Cancelled -> {
                    previewInFlight = null
                    publish(opened) { it.copy(preview = PanoPreviewRun.Idle) }
                    return
                }
            }
            delay(PREVIEW_POLL_MS)
        }
    }

    private suspend fun follow(inputs: PanoInputs, id: String, generation: Int, opened: Int) {
        var misses = 0
        while (true) {
            val job =
                try {
                    withContext(io) { client.job(inputs.server, inputs.account, id) }.also { misses = 0 }
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    if (failure is PanoRefusal || ++misses >= POLL_MISSES) {
                        if (generation == stitchGeneration)
                            publish(opened) {
                                it.copy(stitch = PanoStitchRun.Failed("", "Lost contact with the server while checking the panorama. ${message(failure, "")}".trim(), id))
                            }
                        return
                    }
                    null
                }
            if (generation != stitchGeneration) return
            if (job != null) {
                val next =
                    when (job.status) {
                        PanoJobStatus.Queued, PanoJobStatus.Running -> {
                            val shown = state.value.stitch as? PanoStitchRun.Running
                            PanoStitchRun.Running(id, job.progress, job.cancelRequested || shown?.cancelRequested == true)
                        }
                        PanoJobStatus.Done -> PanoStitchRun.Done(job)
                        PanoJobStatus.Failed -> PanoStitchRun.Failed("", job.error ?: "Panorama job failed.")
                        PanoJobStatus.Cancelled -> PanoStitchRun.Cancelled
                    }
                publish(opened) { it.copy(stitch = next) }
                if (!job.status.active) return
            }
            delay(STITCH_POLL_MS)
        }
    }

    private fun libraryFor(server: String, account: String, photos: List<Photo>, first: String): String {
        val libraries = client.libraries(server, account)
        val slug = photos.firstOrNull { it.uri.getQueryParameter("path") == first }
            ?.uri?.getQueryParameter("address")?.substringBefore(':')
        return (libraries.firstOrNull { it.slug == slug } ?: PanoramaWire.libraryHolding(libraries, first))?.id
            ?: throw IOException("The selected photos are not in a library on this server.")
    }

    private fun current(opened: Int, inputs: PanoInputs) = opened == session && account(inputs.server) == inputs.account

    private fun publish(opened: Int, transform: (PanoramaState) -> PanoramaState) {
        val inputs = state.value.inputs ?: return
        if (opened != session) return
        if (account(inputs.server) != inputs.account) return drop()
        mutable.value = transform(state.value)
    }

    private fun cancelOnServer(inputs: PanoInputs, id: String) {
        scope.launch(NonCancellable) { withContext(io) { cancelQuietly(inputs, id) } }
    }

    /** Best effort: an unreachable server cannot be told, and the job then finishes unwatched. */
    private fun cancelQuietly(inputs: PanoInputs, id: String) {
        if (account(inputs.server) != inputs.account) return
        try {
            client.cancel(inputs.server, inputs.account, id)
        } catch (_: Exception) {}
    }

    private fun stitchFailure(failure: Exception): PanoStitchRun.Failed {
        val refusal = failure as? PanoRefusal
        return PanoStitchRun.Failed(refusal?.code.orEmpty(), message(failure, "Could not start the panorama."))
    }

    private fun previewMessage(failure: Exception): String =
        if (failure is PanoRefusal && failure.code == "pano_job_running")
            "A panorama is being stitched; the preview will be available afterwards."
        else message(failure, "Preview failed.")

    private fun message(failure: Exception, fallback: String) = failure.message?.takeIf { it.isNotBlank() } ?: fallback

    companion object {
        const val PREVIEW_DEBOUNCE_MS = 600L
        const val PREVIEW_POLL_MS = 1_000L
        const val STITCH_POLL_MS = 2_000L
        private const val POLL_MISSES = 3

        fun refusal(photos: List<Photo>): String? {
            if (photos.size < 2) return "Select at least two photos to merge."
            if (photos.any { !CloudLibrary.isCloud(it.uri) || it.uri.getQueryParameter("path") == null })
                return "Panoramas are merged by a Maple server. Select photos from one connected server."
            if (photos.map { it.uri.host }.toSet().size != 1) return "Select photos from one server to merge."
            if (photos.map { it.uri.getQueryParameter("path") }.distinct().size < 2)
                return "Select at least two different photos to merge."
            return null
        }
    }
}
