package app.justmaple.aperture.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.justmaple.aperture.*
import kotlinx.coroutines.launch

@Composable
fun MapleShell(model: MapleViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf("Library") }
    var query by rememberSaveable { mutableStateOf("") }
    var recovery by rememberSaveable { mutableStateOf<String?>(null) }
    var cloudDialog by rememberSaveable { mutableStateOf(false) }
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    var sourcesVisible by rememberSaveable { mutableStateOf(true) }
    var info by rememberSaveable { mutableStateOf(false) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val folderTree = remember(model.library, scope) { FolderTree(model.library, scope) }
    LaunchedEffect(state.sources, state.folder, state.folderTrail, state.folders, state.loading) {
        folderTree.syncSources(state.sources)
        if (!state.loading) state.folder?.let { folderTree.seed(it, state.folders) }
        folderTree.reveal(state.folderTrail)
    }
    val folderPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) {
            it?.let(model::remember)
        }
    val photoPicker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {
            it?.let(model::openSingle)
        }
    val export =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/jpeg")) {
            uri ->
            if (uri != null)
                scope.launch { runCatching { model.export(uri, false) }.onFailure(model::report) }
        }
    val sidecar =
        rememberLauncherForActivityResult(
            ActivityResultContracts.CreateDocument("application/rdf+xml")
        ) { uri ->
            if (uri != null)
                scope.launch { runCatching { model.export(uri, true) }.onFailure(model::report) }
        }
    val configuration = LocalConfiguration.current
    val tablet = configuration.smallestScreenWidthDp >= 600
    val pinnedSources = tablet && configuration.screenWidthDp >= 1000 && sourcesVisible
    val inlineInfo = tablet && configuration.screenWidthDp >= 1000
    val browsing = state.mode == PhotoMode.Browse
    BackHandler(!browsing) { model.back() }
    BackHandler(browsing && drawer.isClosed && state.folderTrail.size > 1) {
        model.browse(state.folderTrail[state.folderTrail.lastIndex - 1])
    }
    val sidebar: @Composable () -> Unit = {
        FolderSources(
            state,
            folderTree,
            onSelect = {
                tab = "Library"
                model.browse(it.folder, it.ancestors)
                scope.launch { drawer.close() }
            },
            onFolder = {
                scope.launch {
                    drawer.close()
                    folderPicker.launch(null)
                }
            },
            onPhoto = {
                scope.launch {
                    drawer.close()
                    photoPicker.launch(arrayOf("image/*", "application/octet-stream"))
                }
            },
            onCloud = { cloudDialog = true },
            onClose = {
                if (pinnedSources) sourcesVisible = false else scope.launch { drawer.close() }
            },
        )
    }
    val content: @Composable () -> Unit = {
        Column(Modifier.fillMaxSize().background(MapleColors.background).safeDrawingPadding()) {
            state.error?.let { message ->
                Row(
                    Modifier.fillMaxWidth()
                        .background(MapleColors.error.copy(alpha = .12f))
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(message, Modifier.weight(1f), color = MapleColors.error)
                    if (state.dirty)
                        TextButton({ recovery = "reload" }) { Text("Reload saved edits") }
                    if (state.canResetRawOnlySliders)
                        TextButton({ recovery = "raster" }) { Text("Reset RAW-only sliders") }
                    TextButton(onClick = model::clearError) { Text("Dismiss") }
                }
            }
            Row(Modifier.weight(1f)) {
                if (pinnedSources)
                    Box(Modifier.width(220.dp).fillMaxHeight().background(MapleColors.sidebar)) {
                        sidebar()
                    }
                Column(Modifier.weight(1f)) {
                    if (browsing) {
                        LibraryHeader(
                            if (tab == "Library")
                                state.folder?.let { "Library — ${it.name}" } ?: "Library"
                            else tab,
                            tablet,
                            onSources = {
                                if (tablet && configuration.screenWidthDp >= 1000)
                                    sourcesVisible = !sourcesVisible
                                else scope.launch { drawer.open() }
                            },
                            onSearch = { tab = "Search" },
                            onSettings = { settingsOpen = true },
                            onFolder = { folderPicker.launch(null) },
                        )
                        when (tab) {
                            "Search" -> {
                                OutlinedTextField(
                                    query,
                                    { query = it },
                                    Modifier.fillMaxWidth().padding(16.dp),
                                    placeholder = { Text("Search photos") },
                                    singleLine = true,
                                    leadingIcon = { Icon(Icons.Outlined.Search, null) },
                                )
                                BrowseGrid(
                                    model,
                                    state,
                                    state.photos.filter {
                                        it.name.contains(query, ignoreCase = true)
                                    },
                                    emptyList(),
                                    folderPicker = { folderPicker.launch(null) },
                                )
                            }
                            else ->
                                BrowseGrid(
                                    model,
                                    state,
                                    state.photos,
                                    state.folders,
                                    folderPicker = { folderPicker.launch(null) },
                                )
                        }
                    } else {
                        PhotoSurface(
                            model,
                            state,
                            tablet,
                            showInspector = !info,
                            onInfo = { info = !info },
                            onExport = {
                                export.launch(
                                    "${state.selected?.name?.substringBeforeLast('.') ?: "photo"}-Maple.jpg"
                                )
                            },
                        )
                    }
                }
                if (inlineInfo && info && !browsing)
                    Box(Modifier.width(280.dp).fillMaxHeight().background(MapleColors.surface)) {
                        InfoPanel(
                            state,
                            onExportSidecar = {
                                sidecar.launch(state.selected?.sidecarName ?: "photo.xmp")
                            },
                        )
                    }
            }
            if (!tablet && browsing) {
                Row(
                    Modifier.fillMaxWidth()
                        .padding(horizontal = 24.dp, vertical = 8.dp)
                        .background(
                            MapleColors.surface,
                            androidx.compose.foundation.shape.CircleShape,
                        ),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    for ((label, icon) in
                        listOf(
                            "Library" to Icons.Outlined.PhotoLibrary,
                            "Search" to Icons.Outlined.Search,
                            "Settings" to Icons.Outlined.Settings,
                        )) {
                        Column(
                            Modifier.weight(1f)
                                .clickable {
                                    if (label == "Settings") settingsOpen = true else tab = label
                                }
                                .padding(10.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Icon(
                                icon,
                                label,
                                tint = if (tab == label) MapleColors.primary else MapleColors.muted,
                                modifier = Modifier.size(22.dp),
                            )
                            Text(
                                label,
                                style = MaterialTheme.typography.labelSmall,
                                color =
                                    if (tab == label) MapleColors.primary else MapleColors.muted,
                            )
                        }
                    }
                }
            }
        }
    }
    LaunchedEffect(state.cloudConnectionsVersion) {
        if (state.cloudConnectionsVersion > 0) {
            cloudDialog = false
            tab = "Library"
            settingsOpen = false
            drawer.close()
        }
    }
    if (recovery != null)
        AlertDialog(
            onDismissRequest = { recovery = null },
            title = {
                Text(if (recovery == "reload") "Reload saved edits?" else "Reset RAW-only sliders?")
            },
            text = {
                Text(
                    if (recovery == "reload")
                        "Your unsaved adjustments will be discarded and the saved sidecar will be loaded."
                    else
                        "Unsupported numeric RAW adjustments will return to their defaults. Other edits and metadata are retained."
                )
            },
            confirmButton = {
                TextButton({
                    if (recovery == "reload") model.reloadSavedEdits()
                    else model.resetRawOnlySliders()
                    recovery = null
                }) {
                    Text("Continue")
                }
            },
            dismissButton = { TextButton({ recovery = null }) { Text("Cancel") } },
            containerColor = MapleColors.surface,
        )
    if (pinnedSources) content()
    else
        ModalNavigationDrawer(
            drawerState = drawer,
            drawerContent = {
                ModalDrawerSheet(
                    drawerContainerColor = MapleColors.sidebar,
                    modifier = Modifier.width(300.dp),
                ) {
                    sidebar()
                }
            },
            gesturesEnabled = browsing,
        ) {
            content()
        }
    if (info && !inlineInfo && !browsing) {
        @OptIn(ExperimentalMaterial3Api::class)
        ModalBottomSheet(
            onDismissRequest = { info = false },
            containerColor = MapleColors.surface,
        ) {
            InfoPanel(
                state,
                onExportSidecar = { sidecar.launch(state.selected?.sidecarName ?: "photo.xmp") },
            )
        }
    }
    if (settingsOpen)
        SettingsSheet(
            model,
            state,
            onFolder = {
                settingsOpen = false
                folderPicker.launch(null)
            },
            onCloud = { cloudDialog = true },
            onDismiss = { settingsOpen = false },
        )
    if (cloudDialog || state.cloudSigningIn)
        CloudConnectionDialog(model, state.cloudSigningIn) { cloudDialog = false }
}

@Composable
fun InfoPanel(state: MapleState, onExportSidecar: () -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        MuiSection("Info") {
            Text(state.selected?.name ?: "No photo")
            Text(state.selected?.extension?.uppercase() ?: "", color = MapleColors.muted)
            Text("${(state.selected?.size ?: 0) / 1024} KB", color = MapleColors.muted)
        }
        MuiSection("Edits") {
            Text(if (state.saving) "Saving…" else if (state.dirty) "Unsaved changes" else "Saved")
            Text(
                if (state.selected?.parent == null) "Sidecar stored on this device"
                else "Sidecar next to original",
                color = MapleColors.muted,
            )
            TextButton(onExportSidecar) { Text("Export XMP sidecar…") }
        }
    }
}
