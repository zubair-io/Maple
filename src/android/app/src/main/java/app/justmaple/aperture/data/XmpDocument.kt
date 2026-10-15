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

    val rating: Int
        get() =
            attribute("xmp:Rating")
                ?.toDoubleOrNull()
                ?.takeIf { it.isFinite() && it in -1.0..5.0 && it == it.toInt().toDouble() }
                ?.toInt() ?: 0

    fun withAttribute(name: String, value: String?) = copy(changes = changes + (name to value))

    fun withoutRawOnlySliders(): XmpDocument =
        AdjustmentFields.all
            .filter { !it.rasterSupported && it.xmp.isNotEmpty() }
            .fold(this) { doc, field -> doc.withField(field, field.initial) }

    fun attribute(name: String): String? {
        if (changes.containsKey(name)) return changes[name]
        return descriptions(original)
            .mapNotNull { (_, scope) -> scope.attributes[name] }
            .lastOrNull()
    }

    fun serialize(): String {
        validate(original)
        val tags = descriptions(original)
        require(tags.isNotEmpty()) { "XMP has no RDF description" }
        val profile =
            attribute("papp:Profile")
                ?: if (attribute("papp:Look") == "Neutral") "Neutral" else "Auto"
        val wbScale =
            attribute("papp:WbScaleVersion")
                ?: if (attribute("crs:Temperature") != null || attribute("crs:Tint") != null) {
                    val mapleAuthored = tags.any { (_, scope) ->
                        scope.bindings.values.any {
                            it == NAMESPACES.getValue("papp") || it in LEGACY_PAPP
                        }
                    }
                    if (mapleAuthored) "1" else AdjustmentFields.whiteBalanceScaleVersion.toString()
                } else null
        val owned =
            changes +
                mapOf(
                    "papp:Profile" to profile,
                    "papp:WbScaleVersion" to wbScale,
                    "crs:HasSettings" to "True",
                    "crs:Version" to (attribute("crs:Version") ?: "11.0"),
                    "crs:ProcessVersion" to (attribute("crs:ProcessVersion") ?: "11.0"),
                )
        val replacements = tags.map { (tag, scope) ->
            val stripped =
                ATTRIBUTE.replace(tag.value) { match ->
                    when {
                        attributeName(match.groupValues[1], scope.bindings) in owned -> ""
                        match.groupValues[1] == "xmlns:papp" &&
                            scope.bindings["papp"] in LEGACY_PAPP ->
                            match.value.replace(match.groupValues[3], NAMESPACES.getValue("papp"))
                        else -> match.value
                    }
                }
            val suffix = if (stripped.endsWith("/>")) "/>" else ">"
            val extra =
                if (tag == tags.last().first)
                    buildString {
                        val prefixes = outputPrefixes(scope.bindings)
                        for ((canonical, uri) in NAMESPACES) {
                            val prefix = prefixes.getValue(canonical)
                            val declared = scope.bindings[prefix]
                            val local =
                                ATTRIBUTE.findAll(tag.value).any {
                                    it.groupValues[1] == "xmlns:$prefix"
                                }
                            if (declared == null || (declared in LEGACY_PAPP && !local))
                                append("\n      xmlns:$prefix=\"$uri\"")
                        }
                        owned.entries
                            .sortedWith(compareBy({ priority(it.key) }, { it.key }))
                            .forEach { (key, value) ->
                                val prefix = key.substringBefore(':')
                                val name =
                                    if (':' !in key) key
                                    else "${prefixes[prefix] ?: prefix}:${key.substringAfter(':')}"
                                if (value != null) append("\n      $name=\"${escape(value)}\"")
                            }
                    }
                else ""
            tag to stripped.dropLast(suffix.length) + extra + suffix
        }
        val size =
            original.length + replacements.sumOf { (tag, value) -> value.length - tag.value.length }
        return buildString(size) {
                for ((index, replacement) in replacements.withIndex()) {
                    val (tag, value) = replacement
                    val start = replacements.getOrNull(index - 1)?.first?.range?.last?.plus(1) ?: 0
                    append(original, start, tag.range.first)
                    append(value)
                }
                append(original, replacements.last().first.range.last + 1, original.length)
            }
            .also(::validate)
    }

    companion object {
        const val EMPTY =
            "<?xpacket begin=\"\uFEFF\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" /></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>"
        private val ATTRIBUTE =
            Regex("""\s+([^\s=<>/'"?]+)\s*=\s*(['"])(.*?)\2""", RegexOption.DOT_MATCHES_ALL)
        private val LEGACY_PAPP = setOf("http://ns.justmaple.app/1.0/", "https://maple.app/ns/1.0/")
        private val DESCRIPTION =
            Regex(
                "<!--.*?-->|<!\\[CDATA\\[.*?\\]\\]>|<\\?.*?\\?>|(<(?:[^\\s<>/!?=:\"']+:)?Description(?=[\\s/>])(?:[^>\"']|\"[^\"]*\"|'[^']*')*>)",
                RegexOption.DOT_MATCHES_ALL,
            )
        private val NAMESPACES =
            mapOf(
                "crs" to "http://ns.adobe.com/camera-raw-settings/1.0/",
                "papp" to "http://ns.justmaple.app/photo/1.0/",
                "xmp" to "http://ns.adobe.com/xap/1.0/",
            )

        private data class DescriptionScope(
            val bindings: Map<String, String>,
            val attributes: Map<String, String>,
            val primary: Boolean,
        )

        private fun outputPrefixes(bindings: Map<String, String>): Map<String, String> =
            NAMESPACES.mapValues { (canonical, uri) ->
                val declared = bindings[canonical]
                if (
                    declared == null ||
                        declared == uri ||
                        (canonical == "papp" && declared in LEGACY_PAPP)
                )
                    canonical
                else
                    bindings.entries.firstOrNull { it.value == uri }?.key
                        ?: generateSequence(0) { it + 1 }
                            .map { if (it == 0) "maple_$canonical" else "maple_${canonical}_$it" }
                            .first { it !in bindings }
            }

        private fun attributeName(name: String, scope: Map<String, String>): String {
            if (':' !in name) return name
            val prefix = name.substringBefore(':')
            val uri = scope[prefix]
            val canonical =
                NAMESPACES.entries
                    .firstOrNull {
                        it.value == uri || (it.key == "papp" && uri in LEGACY_PAPP)
                    }
                    ?.key
            return if (canonical != null) "$canonical:${name.substringAfter(':')}"
            else if (prefix in NAMESPACES) "" else name
        }

        private fun descriptions(xml: String): List<Pair<MatchResult, DescriptionScope>> {
            val tags = DESCRIPTION.findAll(xml).filter { it.groupValues[1].isNotEmpty() }.toList()
            val scopes = descriptionBindings(xml)
            require(tags.size == scopes.size) { "Unsupported RDF description syntax" }
            return tags.zip(scopes).filter { it.second.primary }
        }

        private fun descriptionBindings(xml: String): List<DescriptionScope> {
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            parser.setInput(StringReader(xml.removePrefix("\uFEFF")))
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
                        parser.eventType == XmlPullParser.START_TAG && parser.name == "Description"
                    ) {
                        val bindings = buildMap {
                            for (i in 0 until parser.getNamespaceCount(parser.depth)) {
                                parser.getNamespacePrefix(i)?.let {
                                    put(it, parser.getNamespaceUri(i))
                                }
                            }
                        }
                        add(
                            DescriptionScope(
                                bindings,
                                buildMap {
                                    for (i in 0 until parser.attributeCount) {
                                        val prefix = parser.getAttributePrefix(i)
                                        val local = parser.getAttributeName(i)
                                        val qualified =
                                            if (prefix.isNullOrEmpty()) local else "$prefix:$local"
                                        put(
                                            attributeName(qualified, bindings),
                                            parser.getAttributeValue(i),
                                        )
                                    }
                                },
                                insideRdf &&
                                    parser.depth == rdfDepth?.plus(1) &&
                                    parser.namespace ==
                                        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
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

        private fun validate(xml: String) {
            require(!xml.contains("<!DOCTYPE", ignoreCase = true)) { "DTD is not supported in XMP" }
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            parser.setInput(StringReader(xml.removePrefix("\uFEFF")))
            while (parser.next() != XmlPullParser.END_DOCUMENT) {
                /* Validate the entire document. */
            }
        }
    }
}
