package app.justmaple.aperture

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals

internal class FloatTiff(data: ByteArray) {
    val bytes =
        ByteBuffer.wrap(data)
            .order(
                if (data[0] == 'I'.code.toByte()) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN
            )
    private val directory = bytes.getInt(4)
    private val entries =
        (0 until unsignedShort(directory)).associate { index ->
            val offset = directory + 2 + index * 12
            unsignedShort(offset) to offset
        }

    init {
        assertEquals(42, unsignedShort(2))
    }

    private fun unsignedShort(offset: Int) = bytes.getShort(offset).toInt() and 0xffff

    fun values(tag: Int): List<Int> {
        val entry = entries.getValue(tag)
        val type = unsignedShort(entry + 2)
        val count = bytes.getInt(entry + 4)
        val size =
            when (type) {
                1,
                7 -> 1
                3 -> 2
                4 -> 4
                else -> error("TIFF type $type")
            }
        val start = if (size * count <= 4) entry + 8 else bytes.getInt(entry + 8)
        return (0 until count).map { index ->
            val offset = start + index * size
            when (size) {
                1 -> bytes.get(offset).toInt() and 0xff
                2 -> unsignedShort(offset)
                else -> bytes.getInt(offset)
            }
        }
    }
}
