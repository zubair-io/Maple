package app.justmaple.aperture.data

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/** Keep the source byte order in the XML declaration so string edits remain lossless. */
internal object XmpEncoding {
    private val declaration = Regex("^\\uFEFF?<\\?xml\\s[^?]*\\?>")
    private val encoding = Regex("\\bencoding\\s*=\\s*(['\"])([^'\"]+)\\1")

    fun decode(bytes: ByteArray, length: Int = bytes.size): String {
        require(length in 0..bytes.size)
        fun starts(vararg signature: Int) =
            length >= signature.size &&
                signature.indices.all { (bytes[it].toInt() and 255) == signature[it] }
        val marker =
            when {
                starts(0, 0, 254, 255) -> "UTF-32BE" to 4
                starts(255, 254, 0, 0) -> "UTF-32LE" to 4
                starts(254, 255) -> "UTF-16BE" to 2
                starts(255, 254) -> "UTF-16LE" to 2
                starts(239, 187, 191) -> "UTF-8" to 3
                starts(0, 0, 0, 60) -> "UTF-32BE" to 0
                starts(60, 0, 0, 0) -> "UTF-32LE" to 0
                starts(0, 60, 0, 63) -> "UTF-16BE" to 0
                starts(60, 0, 63, 0) -> "UTF-16LE" to 0
                else -> null
            }
        val asciiDeclaration =
            if (
                marker == null &&
                    starts(60, 63, 120, 109, 108) &&
                    bytes.getOrNull(5)?.toInt() in listOf(9, 10, 13, 32)
            ) {
                val end =
                    (6 until length).firstOrNull {
                        bytes[it - 1] == 63.toByte() && bytes[it] == 62.toByte()
                    }
                end?.let { bytes.copyOfRange(0, it + 1).toString(Charsets.ISO_8859_1) }
            } else null
        val declared = asciiDeclaration?.let(::declaredCharset)
        val charset = Charset.forName(marker?.first ?: declared?.name() ?: "UTF-8")
        val offset = marker?.second ?: 0
        val text =
            if (charset == Charsets.UTF_8) {
                validateUtf8(bytes, offset, length)
                String(bytes, offset, length - offset, charset)
            } else
                try {
                    charset
                        .newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(bytes, offset, length - offset))
                        .toString()
                } catch (failure: CharacterCodingException) {
                    throw IOException(
                        "The XMP sidecar does not match its ${charset.name()} encoding",
                        failure,
                    )
                }
        val document = if (offset > 0) "\uFEFF$text" else text
        val label = declaredCharset(document)?.name()
        require(
            label == null ||
                label == charset.name() ||
                (label == "UTF-16" && charset.name().startsWith("UTF-16")) ||
                (label == "UTF-32" && charset.name().startsWith("UTF-32"))
        ) {
            "The XMP encoding declaration does not match its bytes"
        }
        return if (charset == Charsets.UTF_8) document else withEncoding(document, charset.name())
    }

    private fun validateUtf8(bytes: ByteArray, offset: Int, length: Int) {
        val decoder =
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
        val input = ByteBuffer.wrap(bytes, offset, length - offset)
        val scratch = CharBuffer.allocate(4096)
        try {
            while (true) {
                scratch.clear()
                val result = decoder.decode(input, scratch, true)
                if (result.isError) result.throwException()
                if (result.isUnderflow) break
            }
            decoder.flush(scratch).takeIf { it.isError }?.throwException()
        } catch (failure: CharacterCodingException) {
            throw IOException("The XMP sidecar contains invalid UTF-8", failure)
        }
    }

    fun encode(xml: String): ByteArray {
        val charset = declaredCharset(xml) ?: Charsets.UTF_8
        if (charset == Charsets.UTF_8) {
            var index = 0
            while (index < xml.length) {
                val ch = xml[index++]
                if (Character.isHighSurrogate(ch)) {
                    require(index < xml.length && Character.isLowSurrogate(xml[index++])) {
                        "Invalid XML character"
                    }
                } else require(!Character.isLowSurrogate(ch)) { "Invalid XML character" }
            }
            return xml.toByteArray(charset)
        }
        val bytes =
            try {
                charset
                    .newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .encode(CharBuffer.wrap(xml))
            } catch (failure: CharacterCodingException) {
                throw IOException(
                    "The edited metadata cannot be represented in the sidecar's ${charset.name()} encoding",
                    failure,
                )
            }
        return ByteArray(bytes.remaining()).also { bytes.get(it) }
    }

    /** The server's path-keyed XMP API accepts Unicode text and publishes UTF-8. */
    fun forCloud(xml: String): String {
        val text = xml.removePrefix("\uFEFF")
        return if (declaredCharset(text)?.let { it == Charsets.UTF_8 } != false) text
        else withEncoding(text, "UTF-8")
    }

    private fun declaredCharset(xml: String): Charset? =
        declaration
            .find(xml)
            ?.value
            ?.let { encoding.find(it)?.groupValues?.get(2) }
            ?.let(Charset::forName)

    private fun withEncoding(xml: String, name: String): String {
        val header = declaration.find(xml)
        if (header == null) {
            if (name == "UTF-8") return xml
            val offset = if (xml.startsWith('\uFEFF')) 1 else 0
            return xml.substring(0, offset) +
                "<?xml version=\"1.0\" encoding=\"$name\"?>\n" +
                xml.substring(offset)
        }
        val match = encoding.find(header.value)
        if (match?.groupValues?.get(2) == name) return xml
        val updated =
            if (match != null) {
                val label = match.groups[2]!!.range
                header.value.replaceRange(label, name)
            } else header.value.dropLast(2) + " encoding=\"$name\"?>"
        return updated + xml.substring(header.range.last + 1)
    }
}
