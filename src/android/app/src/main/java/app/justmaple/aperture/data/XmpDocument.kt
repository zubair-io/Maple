package app.justmaple.aperture.data

import android.util.Xml
import app.justmaple.aperture.generated.AdjustmentField
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.StringReader
import java.util.Locale
import org.xmlpull.v1.XmlPullParser

/** A lexical patch preserves all unedited XML bytes, including foreign data. */
data class XmpDocument(
    val original: String = EMPTY,
    val changes: Map<String, String?> = emptyMap(),
) {
    fun withField(field: AdjustmentField, value: Float): XmpDocument {
        require(value.isFinite() && value in field.minimum..field.maximum)
        require(field.xmp.isNotEmpty()) { "No scalar XMP representation for ${field.name}" }
        val number = format(value)
        val additions = mapOf(field.xmp to if (number == format(field.initial)) null else number)
        val wb =
            if (field.name == "temperature" || field.name == "tint")
                mapOf(
                    field.xmp to number,
                    "crs:WhiteBalance" to "Custom",
                    "papp:WbScaleVersion" to AdjustmentFields.whiteBalanceScaleVersion.toString(),
                    "papp:WbSource" to "Manual",
                )
            else emptyMap()
        return copy(changes = changes + additions + wb)
    }

    fun withAttribute(name: String, value: String?) = copy(changes = changes + (name to value))

    fun attribute(name: String): String? {
        if (changes.containsKey(name)) return changes[name]
        return descriptions(original)
            .flatMap { (tag, _) -> ATTRIBUTE.findAll(tag.value).toList() }
            .lastOrNull { it.groupValues[1] == name }
            ?.let { unescape(it.groupValues[3]) }
    }

    fun serialize(): String {
        validate(original)
        val tags = descriptions(original)
        require(tags.isNotEmpty()) { "XMP has no RDF description" }
        val profile =
            attribute("papp:Profile")
                ?: if (attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
        val owned =
            changes +
                mapOf(
                    "papp:Profile" to profile,
                    "crs:HasSettings" to "True",
                    "crs:Version" to (attribute("crs:Version") ?: "11.0"),
                    "crs:ProcessVersion" to (attribute("crs:ProcessVersion") ?: "11.0"),
                )
        val result = StringBuilder(original)
        tags.asReversed().forEach { (tag, scope) ->
            val stripped =
                ATTRIBUTE.replace(tag.value) { match ->
                    when {
                        match.groupValues[1] in owned -> ""
                        match.groupValues[1] == "xmlns:papp" &&
                            match.groupValues[3] == LEGACY_PAPP ->
                            match.value.replace(LEGACY_PAPP, NAMESPACES.getValue("papp"))
                        else -> match.value
                    }
                }
            val suffix = if (stripped.endsWith("/>")) "/>" else ">"
            val extra =
                if (tag == tags.last().first)
                    buildString {
                        for ((prefix, uri) in NAMESPACES) {
                            val declared = scope[prefix]
                            require(
                                declared == null ||
                                    declared == uri ||
                                    (prefix == "papp" && declared == LEGACY_PAPP)
                            ) {
                                "Conflicting $prefix namespace"
                            }
                            val local =
                                ATTRIBUTE.findAll(tag.value).any {
                                    it.groupValues[1] == "xmlns:$prefix"
                                }
                            if (declared == null || (declared == LEGACY_PAPP && !local))
                                append("\n      xmlns:$prefix=\"$uri\"")
                        }
                        owned.entries
                            .sortedWith(compareBy({ priority(it.key) }, { it.key }))
                            .forEach { (key, value) ->
                                if (value != null) append("\n      $key=\"${escape(value)}\"")
                            }
                    }
                else ""
            result.replace(
                tag.range.first,
                tag.range.last + 1,
                stripped.dropLast(suffix.length) + extra + suffix,
            )
        }
        return result.toString().also(::validate)
    }

    companion object {
        const val EMPTY =
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" /></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>"
        private val ATTRIBUTE =
            Regex("\\s+([\\w.-]+:[\\w.-]+)\\s*=\\s*(['\"])(.*?)\\2", RegexOption.DOT_MATCHES_ALL)
        private const val LEGACY_PAPP = "http://ns.justmaple.app/1.0/"
        private val DESCRIPTION =
            Regex(
                "<!--.*?-->|<!\\[CDATA\\[.*?\\]\\]>|<\\?.*?\\?>|<rdf:Description\\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>",
                RegexOption.DOT_MATCHES_ALL,
            )
        private val NAMESPACES =
            mapOf(
                "crs" to "http://ns.adobe.com/camera-raw-settings/1.0/",
                "papp" to "http://ns.justmaple.app/photo/1.0/",
                "xmp" to "http://ns.adobe.com/xap/1.0/",
            )

        private data class DescriptionScope(val bindings: Map<String, String>, val primary: Boolean)

        private fun descriptions(xml: String): List<Pair<MatchResult, Map<String, String>>> {
            val tags =
                DESCRIPTION.findAll(xml).filter { it.value.startsWith("<rdf:Description") }.toList()
            val scopes = descriptionBindings(xml)
            require(tags.size == scopes.size) { "Unsupported RDF description syntax" }
            return tags
                .zip(scopes)
                .filter { it.second.primary }
                .map { it.first to it.second.bindings }
        }

        private fun descriptionBindings(xml: String): List<DescriptionScope> {
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            parser.setInput(StringReader(xml))
            var rdfDepth: Int? = null
            var insideRdf = false
            return buildList {
                while (parser.next() != XmlPullParser.END_DOCUMENT) {
                    if (
                        rdfDepth == null &&
                            parser.eventType == XmlPullParser.START_TAG &&
                            parser.name == "RDF" &&
                            parser.namespace == "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                    ) {
                        rdfDepth = parser.depth
                        insideRdf = true
                    }
                    if (parser.eventType == XmlPullParser.END_TAG && parser.depth == rdfDepth)
                        insideRdf = false
                    if (
                        parser.eventType == XmlPullParser.START_TAG &&
                            parser.prefix == "rdf" &&
                            parser.name == "Description"
                    ) {
                        require(parser.namespace == "http://www.w3.org/1999/02/22-rdf-syntax-ns#") {
                            "Conflicting RDF namespace"
                        }
                        add(
                            DescriptionScope(
                                buildMap {
                                    for (i in 0 until parser.getNamespaceCount(parser.depth)) {
                                        parser.getNamespacePrefix(i)?.let {
                                            put(it, parser.getNamespaceUri(i))
                                        }
                                    }
                                },
                                insideRdf && parser.depth == rdfDepth?.plus(1),
                            )
                        )
                    }
                }
            }
        }

        private fun priority(name: String) =
            when (name.substringBefore(':')) {
                "xmp" -> 0
                "crs" -> 1
                "papp" -> 2
                else -> 500
            }

        fun format(value: Float) =
            String.format(Locale.ROOT, "%.2f", value).trimEnd('0').trimEnd('.').let {
                if (it == "-0") "0" else it
            }

        private fun escape(value: String) =
            value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")

        private fun unescape(value: String) =
            value
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")

        private fun validate(xml: String) {
            require(!xml.contains("<!DOCTYPE", ignoreCase = true)) { "DTD is not supported in XMP" }
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            parser.setInput(StringReader(xml))
            while (parser.next() != XmlPullParser.END_DOCUMENT) {
                /* Validate the entire document. */
            }
        }
    }
}
