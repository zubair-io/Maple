package app.justmaple.aperture.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.*
import app.justmaple.aperture.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun BrowseSelectionControls(model: MapleViewModel, state: MapleState, visible: List<Photo>) {
    val selection by model.browseSelection.state.collectAsState()
    val batch by model.batchSettings.state.collectAsState()
    val selected = visible.filter { it.uri.toString() in selection.ids }
    val scope = rememberCoroutineScope()
    var reviewing by remember { mutableStateOf(false) }
    var preparing by remember { mutableStateOf(false) }
    var reviewPhotos by remember { mutableStateOf(emptyList<Photo>()) }
    var targets by remember { mutableStateOf(emptyList<Pair<XmpDocument, Boolean>>()) }
    var reviewError by remember { mutableStateOf<String?>(null) }
    var failures by remember { mutableStateOf(false) }
    var dismissing by remember { mutableStateOf(false) }
    BackHandler(selection.active) { model.browseSelection.cancel() }
    if (selection.active) {
        Surface(shape = RoundedCornerShape(16.dp), color = MapleColors.raised,
            modifier = Modifier.fillMaxWidth().padding(8.dp).testTag("browse-selection-bar")) {
            Column(Modifier.padding(8.dp)) {
                Text("${selected.size} selected", style = MaterialTheme.typography.titleSmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { model.browseSelection.selectAll(visible) },
                        enabled = visible.isNotEmpty(), modifier = Modifier.testTag("browse-select-all")) { Text("Select all") }
                    TextButton(onClick = { model.browseSelection.clear() },
                        enabled = selected.isNotEmpty(), modifier = Modifier.testTag("browse-select-none")) { Text("Clear") }
                    TextButton(onClick = {
                        preparing = true
                        reviewError = null
                        reviewPhotos = selected
                        scope.launch {
                            try {
                                if (!model.flush()) return@launch
                                val errors = mutableListOf<String>()
                                targets = reviewPhotos.mapNotNull { photo ->
                                    try {
                                        model.library.loadSidecar(photo).document to isRawTransferTarget(photo)
                                    } catch (failure: Exception) {
                                        if (failure is CancellationException) throw failure
                                        errors += "${photo.name}: ${failure.message ?: "Could not read sidecar"}"
                                        null
                                    }
                                }
                                reviewError = errors.takeIf { it.isNotEmpty() }?.joinToString("\n")
                                reviewing = targets.isNotEmpty() && model.browseSelection.state.value.active &&
                                    model.browseSelection.state.value.ids == reviewPhotos.map { it.uri.toString() }.toSet()
                            } catch (failure: Exception) {
                                if (failure is CancellationException) throw failure
                                reviewError = failure.message ?: "Could not read selection"
                            } finally { preparing = false }
                        }
                    }, enabled = selected.isNotEmpty() && state.copiedSettings != null && !preparing &&
                        !batch.running && batch.pending == 0 && batch.failed == 0,
                        modifier = Modifier.testTag("browse-paste-settings")) { Text(if (preparing) "Reading…" else "Paste settings…") }
                    TextButton(onClick = { model.browseSelection.cancel() },
                        modifier = Modifier.testTag("browse-selection-cancel")) { Text("Cancel") }
                }
                reviewError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    val copied = state.copiedSettings
    if (reviewing && copied != null && targets.isNotEmpty()) {
        PasteSettingsDialog(targets.first().first, copied, targets.first().second,
            onPaste = { groups ->
                reviewing = false
                model.pasteSelection(reviewPhotos, groups, copied)
            }, onDismiss = { reviewing = false }, targets = targets, reviewMessage = reviewError)
    }
    if (batch.hasJob) {
        Surface(color = MapleColors.raised, shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth().padding(8.dp).testTag("browse-paste-progress")) {
            Column(Modifier.padding(12.dp)) {
                Text("${batch.completed} saved · ${batch.pending} pending · ${batch.failed} failed")
                if (batch.running) LinearProgressIndicator(Modifier.fillMaxWidth())
                FlowRow {
                    if (batch.running) TextButton(onClick = { model.batchSettings.cancel() }) { Text("Cancel paste") }
                    if (!batch.running && batch.pending > 0)
                        TextButton(onClick = { model.resumeBatchPaste() }) { Text("Resume") }
                    if (!batch.running && batch.failed > 0) {
                        TextButton(onClick = { model.resumeBatchPaste(retryFailed = true) }) { Text("Retry failed") }
                        TextButton(onClick = { failures = true }) { Text("View failures") }
                    }
                    if (!batch.running) TextButton(onClick = {
                        if (batch.pending + batch.failed > 0) dismissing = true else model.dismissBatchPaste()
                    }) { Text("Dismiss batch") }
                }
            }
        }
    }
    if (failures) AlertDialog(onDismissRequest = { failures = false },
        title = { Text("Paste failures") },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) {
            batch.entries.filter { it.error != null }.forEach { Text("${it.photo.name}: ${it.error}") }
        } }, confirmButton = { TextButton(onClick = { failures = false }) { Text("Close") } })
    if (dismissing) AlertDialog(onDismissRequest = { dismissing = false },
        title = { Text("Dismiss this batch?") },
        text = { Text("Pending photos and failed photos will not be retried. Saved sidecars are kept.") },
        confirmButton = { TextButton(onClick = {
            dismissing = false
            model.dismissBatchPaste()
        }) { Text("Dismiss batch") } },
        dismissButton = { TextButton(onClick = { dismissing = false }) { Text("Keep batch") } })
}
