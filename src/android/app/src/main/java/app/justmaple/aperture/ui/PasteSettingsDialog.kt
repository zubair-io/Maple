package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.data.CopiedSettings
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.transferDifferences
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.generated.AdjustmentTransferGroup

/** Pick the groups to paste after reviewing each one's current → incoming values on this photo. */
@Composable
fun PasteSettingsDialog(
    target: XmpDocument,
    copied: CopiedSettings,
    raw: Boolean,
    onPaste: (List<AdjustmentTransferGroup>) -> Unit,
    onDismiss: () -> Unit,
) {
    var selected by remember { mutableStateOf(AdjustmentTransfer.groups.map { it.id }.toSet()) }
    val differences =
        remember(target, copied, raw) {
            AdjustmentTransfer.groups.associate { it.id to transferDifferences(target, copied, it, raw) }
        }
    AlertDialog(
        modifier = Modifier.testTag("paste-settings-dialog"),
        onDismissRequest = onDismiss,
        title = { Text("Paste Settings") },
        text = {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("From ${copied.sourceName}", color = MapleColors.muted, fontSize = 13.sp)
                for (group in AdjustmentTransfer.groups) {
                    val checked = group.id in selected
                    Row(
                        Modifier.fillMaxWidth()
                            .toggleable(checked, role = Role.Checkbox) {
                                selected = if (it) selected + group.id else selected - group.id
                            }
                            .testTag("paste-group-${group.id}"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked, onCheckedChange = null)
                        Text(group.label, Modifier.padding(start = 8.dp))
                    }
                    if (checked) GroupDifferences(group, differences.getValue(group.id))
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onPaste(AdjustmentTransfer.groups.filter { it.id in selected }) },
                enabled = selected.isNotEmpty(),
                modifier = Modifier.testTag("paste-settings-apply"),
            ) {
                Text("Paste")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("paste-settings-cancel")) {
                Text("Cancel")
            }
        },
        containerColor = MapleColors.surface,
    )
}

@Composable
private fun GroupDifferences(
    group: AdjustmentTransferGroup,
    rows: List<app.justmaple.aperture.data.TransferDifference>,
) {
    Column(
        Modifier.fillMaxWidth().padding(start = 40.dp).testTag("paste-preview-${group.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (rows.isEmpty()) Text("No change", color = MapleColors.muted, fontSize = 12.sp)
        for (row in rows) {
            Column(
                Modifier.semantics(mergeDescendants = true) {
                    contentDescription = "${row.label}: ${row.current} to ${row.incoming}"
                }
            ) {
                Text(row.label, fontSize = 12.sp)
                Text(
                    "${row.current} → ${row.incoming}",
                    color = MapleColors.muted,
                    fontSize = 12.sp,
                )
            }
        }
    }
}
