package app.justmaple.aperture.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.justmaple.aperture.cloud.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The Panorama Merge Modal for a connected server's selection (#5994). */
@Composable
internal fun PanoramaSheet(
    state: PanoramaState,
    session: PanoramaSession,
    onViewResult: () -> Unit,
    onClose: () -> Unit,
) {
    Dialog(
        onDismissRequest = { if (state.closable) onClose() },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Surface(
            color = MapleColors.surface,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth().widthIn(max = 840.dp).padding(16.dp).safeDrawingPadding()
                .testTag("pano-sheet"),
        ) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Merge to panorama", style = MaterialTheme.typography.titleLarge)
                Text("${state.photos.size} photos on this server", color = MapleColors.muted)
                when (val config = state.config) {
                    PanoConfigState.Loading -> Busy("Reading the server's panorama settings…", null, "pano-config-loading")
                    is PanoConfigState.Failed -> {
                        Problem(config.message, "pano-config-error")
                        TextButton(onClick = { session.open(state.photos) },
                            modifier = Modifier.testTag("pano-config-retry")) { Text("Try again") }
                    }
                    is PanoConfigState.Ready ->
                        if (!config.capabilities.ready) Problem(
                            "Panorama merging is not set up on this server. An owner can set the maple-cli path " +
                                "and enable it in the server's Settings → Pano.", "pano-not-provisioned")
                        else Ready(state, session, config.capabilities)
                }
                StitchStatus(state, session, onViewResult)
                state.outputError?.let { Problem(it, "pano-output-error") }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (state.closable)
                        TextButton(onClick = onClose, modifier = Modifier.testTag("pano-close")) { Text("Close") }
                    if (state.stitching) {
                        TextButton(onClick = session::cancelStitch, enabled = !state.cancelling,
                            modifier = Modifier.testTag("pano-cancel")) {
                            Text(if (state.cancelling) "Cancelling…" else "Cancel panorama")
                        }
                    } else {
                        val retained = (state.stitch as? PanoStitchRun.Failed)?.jobId != null
                        if (state.stitch !is PanoStitchRun.Done && !retained)
                            Button(onClick = session::stitch, enabled = state.capabilities?.ready == true,
                                modifier = Modifier.testTag("pano-create")) { Text("Create panorama") }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Ready(state: PanoramaState, session: PanoramaSession, capabilities: PanoCapabilities) {
    val options = state.options
    val locked = state.stitching
    Choice("Retention", PanoRetention.entries, options.retention, { it.label }, locked, "pano-retention") {
        session.setOptions(options.copy(retention = it))
    }
    Choice("Local alignment", PanoLocalAlign.entries, options.localAlign, { it.label }, locked, "pano-local-align") {
        session.setOptions(options.copy(localAlign = it))
    }
    if (capabilities.strategy)
        Choice("Projection", PanoStrategy.entries, options.strategy, { it.label }, locked, "pano-strategy") {
            session.setOptions(options.copy(strategy = it))
        }
    if (capabilities.edges) {
        var warp by remember(options.boundaryWarp) { mutableFloatStateOf(options.boundaryWarp.toFloat()) }
        Text("Boundary Warp: ${warp.toInt()}%")
        Slider(value = warp, onValueChange = { warp = it }, valueRange = 0f..100f, enabled = !locked,
            onValueChangeFinished = { session.setOptions(options.copy(boundaryWarp = warp.toInt())) },
            modifier = Modifier.fillMaxWidth().testTag("pano-boundary-warp")
                .semantics { contentDescription = "Boundary Warp"; stateDescription = "${warp.toInt()} percent" })
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("Auto Crop", Modifier.weight(1f))
            Switch(checked = options.autoCrop, enabled = !locked,
                onCheckedChange = { session.setOptions(options.copy(autoCrop = it)) },
                modifier = Modifier.testTag("pano-auto-crop").semantics { contentDescription = "Auto Crop" })
        }
    }
    if (!capabilities.preview)
        Text("This server's maple-cli has no quick preview. Create panorama still merges the photos.",
            color = MapleColors.muted, modifier = Modifier.testTag("pano-preview-unsupported"))
    else Preview(state, session)
}

@Composable
private fun Preview(state: PanoramaState, session: PanoramaSession) {
    when (val run = state.preview) {
        is PanoPreviewRun.Running -> Busy(if (state.image == null) "Preparing preview · ${run.progress?.label ?: "Starting…"}"
            else "Updating preview · ${run.progress?.label ?: "Starting…"}", run.progress?.fraction, "pano-preview-progress")
        is PanoPreviewRun.Failed -> {
            Problem(run.message, "pano-preview-error")
            TextButton(onClick = session::retryPreview, enabled = !state.stitching,
                modifier = Modifier.testTag("pano-preview-retry")) { Text("Retry preview") }
        }
        PanoPreviewRun.Idle -> Unit
    }
    val image = state.image ?: return
    val bitmap by produceState<ImageBitmap?>(null, image.jobId) {
        value = withContext(Dispatchers.Default) {
            BitmapFactory.decodeByteArray(image.png, 0, image.png.size)?.asImageBitmap()
        }
    }
    val current = state.previewCurrent
    Box(Modifier.fillMaxWidth().aspectRatio(image.width.toFloat() / image.height).background(MapleColors.canvas)) {
        bitmap?.let {
            Image(it, "Panorama preview, ${image.width} by ${image.height} pixels" + if (current) "" else ", out of date",
                Modifier.fillMaxSize().testTag("pano-preview-image"), contentScale = ContentScale.Fit)
        }
    }
    Text("Uncropped preview · ${image.width} × ${image.height} px" + if (current) "" else " · out of date",
        color = MapleColors.muted, modifier = Modifier.testTag("pano-preview-size"))
    image.matcherNote?.let { Text(it, color = MapleColors.muted) }
    Text("Frames, in the server's order", style = MaterialTheme.typography.titleSmall)
    image.frames.forEachIndexed { index, frame ->
        Text("${index + 1}. ${frame.name}", Modifier.testTag("pano-frame-$index"))
    }
}

@Composable
private fun StitchStatus(state: PanoramaState, session: PanoramaSession, onViewResult: () -> Unit) {
    when (val run = state.stitch) {
        PanoStitchRun.Idle -> Unit
        is PanoStitchRun.Submitting ->
            Busy(if (run.cancelRequested) "Cancelling the panorama…" else "Queuing the panorama…", null, "pano-stitch-progress")
        is PanoStitchRun.Running ->
            Busy(if (run.cancelRequested) "Cancelling the panorama…" else "Merging · ${run.progress?.label ?: "Starting…"}",
                run.progress?.fraction, "pano-stitch-progress")
        is PanoStitchRun.Done -> {
            Text("Panorama created" + (run.job.outputPath?.let { " · ${it.substringAfterLast('/')}" } ?: ""),
                modifier = Modifier.testTag("pano-stitch-done"))
            run.job.matcherNote?.let { Text(it, color = MapleColors.muted) }
            Button(onClick = onViewResult, modifier = Modifier.testTag("pano-view-result")) { Text("View panorama") }
        }
        is PanoStitchRun.Failed -> {
            Problem(run.message, "pano-stitch-error")
            TextButton(onClick = session::retryStitch, modifier = Modifier.testTag("pano-stitch-retry")) {
                Text(if (run.jobId != null) "Check again" else "Try again")
            }
        }
        PanoStitchRun.Cancelled -> Text("Panorama cancelled.", modifier = Modifier.testTag("pano-stitch-cancelled"))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> Choice(label: String, entries: List<T>, selected: T, name: (T) -> String, locked: Boolean,
    tag: String, onSelect: (T) -> Unit) {
    Text(label)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        entries.forEach { entry ->
            FilterChip(selected = entry == selected, onClick = { onSelect(entry) }, enabled = !locked,
                label = { Text(name(entry)) },
                modifier = Modifier.testTag("$tag-${name(entry)}").semantics { contentDescription = "$label: ${name(entry)}" })
        }
    }
}

@Composable
private fun Busy(label: String, fraction: Float?, tag: String) {
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label)
        if (fraction == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        else LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun Problem(message: String, tag: String) {
    Text(message, color = MapleColors.error, modifier = Modifier.testTag(tag))
}
