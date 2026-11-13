package app.justmaple.aperture.data

/** A primary `rdf:Description` start tag, its source range and in-scope prefixes; the
 * default namespace in force there, if any, is kept apart from the prefixes. */
internal class DescriptionTag(
    val range: IntRange,
    val text: String,
    val bindings: Map<String, String>,
    val defaultNamespace: String? = null,
) {
    val selfClosing: Boolean
        get() = text.endsWith("/>")

    /** [bindings] plus the default namespace under the empty prefix. */
    val scope: Map<String, String>
        get() = defaultNamespace?.let { bindings + ("" to it) } ?: bindings
}

internal class XmlEdit(val start: Int, val end: Int, val text: String)

internal const val RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

private val TOKEN =
    Regex(
        """<!--.*?-->|<!\[CDATA\[.*?]]>|<\?.*?\?>|</([^\s>]+)\s*>|<([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>""",
        RegexOption.DOT_MATCHES_ALL,
    )
private val XMLNS = Regex("""\sxmlns(?::([^\s=]+))?\s*=\s*(['"])(.*?)\2""")

internal class Child(val name: String, val tag: String, val start: Int, val end: Int)

internal class Children(children: List<Child>, val closeStart: Int) : List<Child> by children

/** Direct children of the element whose content starts at [content], and its closing tag. */
internal fun directChildren(xml: String, content: Int): Children {
    val children = mutableListOf<Child>()
    var depth = 1
    var open: MatchResult? = null
    for (token in TOKEN.findAll(xml, content)) {
        val (endName, startName, _, selfClose) = token.destructured
        when {
            endName.isNotEmpty() -> {
                depth -= 1
                if (depth == 0) return Children(children, token.range.first)
                if (depth == 1) open?.let {
                    children += Child(it.groupValues[2], it.value, it.range.first, token.range.last)
                    open = null
                }
            }
            startName.isNotEmpty() && selfClose.isEmpty() -> {
                if (depth == 1) open = token
                depth += 1
            }
            startName.isNotEmpty() && depth == 1 ->
                children += Child(startName, token.value, token.range.first, token.range.last)
        }
    }
    error("Unclosed RDF description")
}

/** The namespaces [child] declares on its own start tag; the default one under "". */
internal fun Child.declarations(): Map<String, String> =
    XMLNS.findAll(tag).associate { it.groupValues[1] to it.groupValues[3] }

/** Every primary description's direct child whose canonical name [matches], with the
 * bindings in force at its description. */
internal fun matchingChildren(
    xml: String,
    descriptions: List<DescriptionTag>,
    canonicalName: (String, Map<String, String>) -> String,
    matches: (String) -> Boolean,
): List<Pair<Child, DescriptionTag>> =
    descriptions.filterNot { it.selfClosing }.flatMap { description ->
        directChildren(xml, description.range.last + 1)
            .filter { matches(canonicalName(it.name, description.scope + it.declarations())) }
            .map { it to description }
    }

/** Removes [child] together with the whitespace that leads up to it. */
internal fun removal(xml: String, child: Child, description: DescriptionTag): XmlEdit =
    XmlEdit(whitespaceStart(xml, child.start, description.range.last + 1), child.end, "")

/** The indent new children of [last] are written at. */
internal fun childIndent(xml: String, last: DescriptionTag): String {
    val close = if (last.selfClosing) null else directChildren(xml, last.range.last + 1).closeStart
    return (close?.takeIf { lineIndentEnd(xml, it) == it }?.let { lineIndent(xml, it) }
        ?: lineIndent(xml, last.range.first)) + "  "
}

/**
 * Appends [block] (lines that each start with a line break) as the last children of
 * [last]. When [last] is self-closing, the second value is the content and end tag
 * that replace its `/>`.
 */
internal fun appendToDescription(xml: String, last: DescriptionTag, block: String): Pair<List<XmlEdit>, String> {
    if (block.isEmpty()) return emptyList<XmlEdit>() to ""
    if (last.selfClosing) {
        val name = last.text.drop(1).takeWhile { !it.isWhitespace() && it != '/' && it != '>' }
        return emptyList<XmlEdit>() to "$block\n${lineIndent(xml, last.range.first)}</$name>"
    }
    val content = last.range.last + 1
    val at = whitespaceStart(xml, directChildren(xml, content).closeStart, content)
    return listOf(XmlEdit(at, at - 1, block)) to ""
}

internal fun whitespaceStart(xml: String, index: Int, floor: Int): Int {
    var start = index
    while (start > floor && xml[start - 1].isWhitespace()) start -= 1
    return start
}

internal fun lineIndent(xml: String, index: Int): String {
    val lineStart = xml.lastIndexOf('\n', index - 1) + 1
    return xml.substring(lineStart, lineIndentEnd(xml, lineStart))
}

private fun lineIndentEnd(xml: String, index: Int): Int {
    val lineStart = xml.lastIndexOf('\n', index - 1) + 1
    var end = lineStart
    while (end < xml.length && (xml[end] == ' ' || xml[end] == '\t')) end += 1
    return end
}
