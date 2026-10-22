package app.justmaple.aperture.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import java.io.Closeable
import java.util.concurrent.Executors
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** One CPU request owns the source and cancellation signal through JNI completion. */
internal class NativeDetailRenderer(
    private val library: PhotoLibrary,
    private val editorSource: suspend (Int) -> Pair<Long, Int>,
) : Closeable {
    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(null, task, "Maple native detail", 16L * 1024 * 1024)
    }.asCoroutineDispatcher()
    private val cleanup = CoroutineScope(SupervisorJob() + worker)
    private val mutex = Mutex()
    private val signalLock = Any()
    private var activeSignal = 0L
    private var serial = 0
    @Volatile private var closed = false
    private var cachedSource = 0L
    private var cachedKey: String? = null

    fun invalidate() = synchronized(signalLock) {
        serial++
        if (activeSignal != 0L) NativeBridge.setCancellation(activeSignal, true)
    }

    suspend fun dimensions(photo: Photo): NativeImageSize = mutex.withLock {
        withContext(worker) {
            check(!closed)
            library.withSourceMetadata(photo) { file ->
                try { NativeImageSize.unpack(NativeBridge.nativeDimensions(file.path, photo.extension)) }
                catch (failure: Exception) {
                    if (photo.extension !in setOf("heic", "heif", "avif")) throw failure
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.path, bounds)
                    val orientation = ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
                    val swap = orientation in setOf(5, 6, 7, 8)
                    NativeImageSize(if (swap) bounds.outHeight else bounds.outWidth,
                        if (swap) bounds.outWidth else bounds.outHeight)
                }
            }
        }
    }

    suspend fun render(request: NativeDetailRequest): Bitmap = mutex.withLock {
        currentCoroutineContext().ensureActive()
        val ticket = synchronized(signalLock) { serial }
        var signal = 0L
        var borrowed = 0L
        var bitmap: Bitmap? = null
        try {
            withContext(NonCancellable + worker) {
                synchronized(signalLock) {
                    if (closed || ticket != serial) throw CancellationException("Retired native-detail request")
                    signal = NativeBridge.createCancellation()
                    activeSignal = signal
                }
                val editor = if (request.editing) editorSource(request.generation) else 0L to 0
                borrowed = editor.first
                val source = if (borrowed != 0L) {
                    clearCached()
                    borrowed
                } else {
                    if (cachedSource == 0L || cachedKey != request.photo.key) {
                        clearCached()
                        cachedSource = library.withOriginal(request.photo) { NativeBridge.openNativeDetail(it.path) }
                        cachedKey = request.photo.key
                    }
                    cachedSource
                }
                val region = request.region
                bitmap = NativeBridge.renderNativeDetail(source, request.xml, region.x, region.y,
                    region.width, region.height, editor.second, signal)
            }
            currentCoroutineContext().ensureActive()
            synchronized(signalLock) {
                if (ticket != serial) throw CancellationException("Retired native-detail result")
            }
            bitmap ?: error("Native detail returned no pixels")
        } catch (failure: Throwable) {
            bitmap?.recycle()
            throw failure
        } finally {
            withContext(NonCancellable + worker) {
                synchronized(signalLock) {
                    if (activeSignal == signal) activeSignal = 0L
                    if (signal != 0L) NativeBridge.closeCancellation(signal)
                }
                if (borrowed != 0L) NativeBridge.closeNativeDetail(borrowed)
            }
        }
    }

    private fun clearCached() {
        if (cachedSource != 0L) NativeBridge.closeNativeDetail(cachedSource)
        cachedSource = 0L
        cachedKey = null
    }

    fun clear() {
        if (closed) return
        invalidate()
        cleanup.launch { mutex.withLock { clearCached() } }
    }

    override fun close() {
        synchronized(signalLock) {
            if (closed) return
            closed = true
        }
        invalidate()
        cleanup.launch { mutex.withLock { clearCached() } }.invokeOnCompletion {
            cleanup.cancel()
            worker.close()
        }
    }
}
