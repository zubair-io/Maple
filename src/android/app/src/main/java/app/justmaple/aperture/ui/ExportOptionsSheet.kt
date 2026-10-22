package app.justmaple.aperture.ui

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

enum class ExportFormat(
    val label: String,
    val extension: String,
    val mimeType: String,
    val compressFormat: Bitmap.CompressFormat,
) {
    JPEG("JPEG", "jpg", "image/jpeg", Bitmap.CompressFormat.JPEG),
    PNG("PNG", "png", "image/png", Bitmap.CompressFormat.PNG),
    WEBP(
        "WebP",
        "webp",
        "image/webp",
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R)
            Bitmap.CompressFormat.WEBP_LOSSY
        else
            @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP,
    ),
}

data class ExportOptions(
    val format: ExportFormat = ExportFormat.JPEG,
    val quality: Int = 92,
    val maxEdge: Int = 4096,
) {
    fun suggestedFileName(sourceName: String?): String {
        val stem = sourceName?.substringBeforeLast('.')?.takeIf { it.isNotEmpty() } ?: "photo"
        return "$stem-Maple.${format.extension}"
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ExportOptionsDialog(
    initial: ExportOptions,
    onConfirm: (ExportOptions) -> Unit,
    onDismiss: () -> Unit,
) {
    var format by remember(initial) { mutableStateOf(initial.format) }
    var quality by remember(initial) { mutableFloatStateOf(initial.quality.toFloat()) }
    var maxEdge by remember(initial) { mutableIntStateOf(initial.maxEdge) }
    AlertDialog(
        modifier = Modifier.testTag("export-options-dialog"),
        onDismissRequest = onDismiss,
        title = { Text("Export options") },
        text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Format")
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (entry in ExportFormat.entries) {
                        FilterChip(
                            modifier = Modifier.testTag("export-format-${entry.name}"),
                            selected = format == entry,
                            onClick = { format = entry },
                            label = { Text(entry.label) },
                        )
                    }
                }
                if (format != ExportFormat.PNG) {
                    Text("Quality: ${quality.toInt()}")
                    Slider(
                        modifier = Modifier.testTag("export-quality-slider").fillMaxWidth(),
                        value = quality,
                        onValueChange = { quality = it },
                        valueRange = 1f..100f,
                    )
                }
                Text("Long edge")
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (edge in listOf(4096, 2048, 1024)) {
                        FilterChip(
                            modifier = Modifier.testTag("export-max-edge-$edge"),
                            selected = maxEdge == edge,
                            onClick = { maxEdge = edge },
                            label = { Text(edge.toString()) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onConfirm(
                        initial.copy(
                            format = format,
                            quality = quality.toInt().coerceIn(1, 100),
                            maxEdge = maxEdge,
                        )
                    )
                }
            ) {
                Text("Export")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = MapleColors.surface,
    )
}
