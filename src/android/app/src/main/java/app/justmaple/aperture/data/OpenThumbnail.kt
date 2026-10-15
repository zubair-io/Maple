package app.justmaple.aperture.data

import java.io.Closeable
import java.io.File

/** The open descriptor keeps bytes readable even when LRU eviction unlinks the path. */
internal class OpenThumbnail(val file: File) : Closeable {
    val input = file.inputStream()

    override fun close() = input.close()

    companion object {
        // All library instances share this process cache. Publication, open and eviction
        // are atomic with respect to each other; network and decoding stay concurrent.
        val lock = Any()
    }
}
