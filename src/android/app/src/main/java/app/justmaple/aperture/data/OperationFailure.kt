package app.justmaple.aperture.data

import android.util.Log

internal fun Throwable.operationMessage(operation: String): String {
    Log.e("Maple", operation, this)
    val detail =
        generateSequence(this) { it.cause }
            .mapNotNull { it.message?.trim()?.takeIf(String::isNotEmpty) }
            .firstOrNull() ?: javaClass.simpleName.ifEmpty { "Unknown error" }
    return "$operation: $detail"
}
