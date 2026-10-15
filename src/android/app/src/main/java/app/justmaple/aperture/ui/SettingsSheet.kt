package app.justmaple.aperture.ui

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.justmaple.aperture.*
import app.justmaple.aperture.cloud.CloudLibrary

/** Grouped destinations mirror the Apple sheet; only implemented panes are exposed (#4623). */
@Composable
internal fun SettingsSheet(
    model: MapleViewModel,
    state: MapleState,
    onFolder: () -> Unit,
    onCloud: () -> Unit,
    onDismiss: () -> Unit,
) {
    var pane by rememberSaveable { mutableStateOf<String?>(null) }
    Dialog(
        onDismissRequest = { if (pane == null) onDismiss() else pane = null },
        properties =
            DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        BoxWithConstraints(
            Modifier.fillMaxSize()
                .safeDrawingPadding()
                .padding(horizontal = 16.dp, vertical = 24.dp),
            contentAlignment = Alignment.Center,
        ) {
            val height = minOf(maxHeight, 640.dp)
            Surface(
                Modifier.widthIn(max = 580.dp)
                    .fillMaxWidth()
                    .height(height)
                    .testTag("settings-sheet"),
                shape = RoundedCornerShape(28.dp),
                color = MapleColors.background,
                contentColor = MapleColors.text,
            ) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(56.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (pane != null)
                            MuiIconButton(
                                "Back to Settings",
                                Icons.AutoMirrored.Outlined.ArrowBack,
                            ) {
                                pane = null
                            }
                        else Spacer(Modifier.width(44.dp))
                        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                            Text(
                                pane ?: "Settings",
                                fontSize = 17.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        MuiIconButton("Close Settings", Icons.Outlined.Close, onClick = onDismiss)
                    }
                    Column(
                        Modifier.weight(1f)
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        when (pane) {
                            null -> {
                                SettingsGroup("General") {
                                    SettingsDestination("General", Icons.Outlined.Settings) {
                                        pane = "General"
                                    }
                                    SettingsDestination(
                                        "Cloud",
                                        Icons.Outlined.Cloud,
                                        last = true,
                                    ) {
                                        pane = "Cloud"
                                    }
                                }
                                SettingsGroup("Files") {
                                    SettingsDestination(
                                        "Sources",
                                        Icons.Outlined.Storage,
                                        last = true,
                                    ) {
                                        pane = "Sources"
                                    }
                                }
                                SettingsGroup("App") {
                                    SettingsDestination("About", Icons.Outlined.Info, last = true) {
                                        pane = "About"
                                    }
                                }
                            }
                            "General" -> {
                                SettingsGroup("Editor") {
                                    Row(
                                        Modifier.fillMaxWidth()
                                            .padding(horizontal = 16.dp, vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            "Show filmstrip",
                                            Modifier.weight(1f),
                                            fontSize = 16.sp,
                                        )
                                        Switch(state.showFilmstrip, model::setFilmstrip)
                                    }
                                }
                                Text(
                                    "Edits save automatically to XMP sidecars. Your original photos stay unchanged.",
                                    color = MapleColors.muted,
                                )
                            }
                            "Cloud" ->
                                SettingsGroup("Maple Cloud") {
                                    state.sources
                                        .filter { CloudLibrary.isCloud(it.uri) }
                                        .forEach { server ->
                                            Row(
                                                Modifier.fillMaxWidth()
                                                    .padding(
                                                        start = 16.dp,
                                                        end = 8.dp,
                                                        top = 8.dp,
                                                        bottom = 8.dp,
                                                    ),
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                Text(server.name, Modifier.weight(1f))
                                                TextButton({ model.disconnectCloud(server) }) {
                                                    Text("Disconnect")
                                                }
                                            }
                                            HorizontalDivider(
                                                color = MapleColors.border,
                                                thickness = .5.dp,
                                            )
                                        }
                                    SettingsDestination(
                                        "Add Maple Cloud server",
                                        Icons.Outlined.AddCircleOutline,
                                        last = true,
                                        onClick = onCloud,
                                    )
                                }
                            "Sources" ->
                                SettingsGroup("Folders") {
                                    state.sources
                                        .filterNot { CloudLibrary.isCloud(it.uri) }
                                        .forEach { folder ->
                                            Row(
                                                Modifier.fillMaxWidth().padding(16.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                Icon(
                                                    Icons.Outlined.Folder,
                                                    null,
                                                    tint = MapleColors.muted,
                                                )
                                                Spacer(Modifier.width(12.dp))
                                                Text(folder.name)
                                            }
                                            HorizontalDivider(
                                                color = MapleColors.border,
                                                thickness = .5.dp,
                                            )
                                        }
                                    SettingsDestination(
                                        "Add folder…",
                                        Icons.Outlined.CreateNewFolder,
                                        last = true,
                                        onClick = onFolder,
                                    )
                                }
                            "About" -> {
                                val context = LocalContext.current
                                val version = remember {
                                    context.packageManager
                                        .getPackageInfo(context.packageName, 0)
                                        .versionName
                                        .orEmpty()
                                }
                                SettingsGroup("Maple") {
                                    Column(
                                        Modifier.padding(20.dp),
                                        verticalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        Text("Maple for Android", fontSize = 20.sp)
                                        Text("Version $version", color = MapleColors.muted)
                                        Text("By Just Maple", color = MapleColors.muted)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            title,
            Modifier.padding(start = 16.dp),
            color = MapleColors.muted,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Surface(shape = RoundedCornerShape(24.dp), color = MapleColors.raised) {
            Column(content = content)
        }
    }
}

@Composable
private fun SettingsDestination(
    label: String,
    icon: ImageVector,
    last: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 64.dp)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = MapleColors.muted)
        Spacer(Modifier.width(12.dp))
        Text(label, Modifier.weight(1f), fontSize = 16.sp)
        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MapleColors.muted)
    }
    if (!last)
        HorizontalDivider(
            Modifier.padding(start = 52.dp, end = 16.dp),
            color = MapleColors.border,
            thickness = .5.dp,
        )
}
