package app.justmaple.aperture.data

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.nio.file.Files
import java.util.Collections
import java.util.IdentityHashMap
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

/** Robolectric stubs descriptor stat and truncation; this answers them from the real file a provider opened. */
@Implements(Os::class)
object DescriptorOs {
    private val opened: MutableMap<FileDescriptor, File> =
        Collections.synchronizedMap(IdentityHashMap())

    fun remember(descriptor: FileDescriptor, file: File) {
        opened[descriptor] = file
    }

    private fun fileOf(descriptor: FileDescriptor) =
        opened[descriptor] ?: throw ErrnoException("fstat", OsConstants.EBADF)

    @JvmStatic
    @Implementation
    fun fstat(descriptor: FileDescriptor): StructStat {
        val path = fileOf(descriptor).toPath()
        val unix = Files.readAttributes(path, "unix:dev,ino,mode,nlink,size")
        return StructStat::class.java
            .getConstructor(
                Long::class.javaPrimitiveType, Long::class.javaPrimitiveType, Int::class.javaPrimitiveType,
                Long::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType,
                Long::class.javaPrimitiveType, Long::class.javaPrimitiveType, Long::class.javaPrimitiveType,
                Long::class.javaPrimitiveType, Long::class.javaPrimitiveType, Long::class.javaPrimitiveType,
                Long::class.javaPrimitiveType,
            )
            .newInstance(
                unix["dev"] as Long, unix["ino"] as Long, unix["mode"] as Int, (unix["nlink"] as Int).toLong(),
                0, 0, 0L, unix["size"] as Long, 0L, 0L, 0L, 0L, 0L,
            )
    }

    @JvmStatic
    @Implementation
    fun ftruncate(descriptor: FileDescriptor, length: Long) {
        FileOutputStream(descriptor).channel.truncate(length)
    }

    @JvmStatic
    @Implementation
    fun lseek(descriptor: FileDescriptor, offset: Long, whence: Int): Long {
        FileOutputStream(descriptor).channel.position(offset)
        return offset
    }

    @JvmStatic
    @Implementation
    fun fsync(descriptor: FileDescriptor) {
        FileOutputStream(descriptor).channel.force(true)
    }
}
