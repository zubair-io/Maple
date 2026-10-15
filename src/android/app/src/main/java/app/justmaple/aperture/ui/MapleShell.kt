package app.justmaple.aperture.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
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
import app.justmaple.aperture.data.Folder
import app.justmaple.aperture.data.Photo
import kotlinx.coroutines.launch

@Composable
fun MapleShell(model: MapleViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf("Library") }
    var query by rememberSaveable { mutableStateOf("") }
    var recovery by rememberSaveable { mutableStateOf<String?>(null) }
    var cloudDialog by rememberSaveable { mutableStateOf(false) }
    var info by rememberSaveable { mutableStateOf(false) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
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
    val pinnedSources = tablet && configuration.screenWidthDp >= 1000
    val inlineInfo = tablet && configuration.screenWidthDp >= 1000
    val browsing = state.mode == PhotoMode.Browse
    BackHandler(!browsing) { model.back() }
    val sidebar: @Composable () -> Unit = {
        Sources(
            state,
            onSelect = {
                tab = "Library"
                model.browse(it)
                scope.launch { drawer.close() }
            },
            onFolder = { folderPicker.launch(null) },
            onPhoto = { photoPicker.launch(arrayOf("image/*", "application/octet-stream")) },
            onCloud = { cloudDialog = true },
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
                    if (message.contains("raster image:"))
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
                        MuiHeader(
                            if (tab == "Library") state.folder?.name ?: "Library" else tab,
                            leading = {
                                if (!pinnedSources)
                                    MuiIconButton("Sources", Icons.Outlined.Menu) {
                                        scope.launch { drawer.open() }
                                    }
                            },
                            actions = {
                                if (tablet) {
                                    MuiIconButton(
                                        "Search",
                                        Icons.Outlined.Search,
                                        selected = tab == "Search",
                                    ) {
                                        tab = "Search"
                                    }
                                    MuiIconButton(
                                        "Settings",
                                        Icons.Outlined.Settings,
                                        selected = tab == "Settings",
                                    ) {
                                        tab = "Settings"
                                    }
                                }
                                if (tab == "Library")
                                    MuiIconButton("Open folder", Icons.Outlined.CreateNewFolder) {
                                        folderPicker.launch(null)
                                    }
                            },
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
                            "Settings" ->
                                SettingsPanel(
                                    model,
                                    state,
                                    onFolder = { folderPicker.launch(null) },
                                    onCloud = { cloudDialog = true },
                                )
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
                            Modifier.weight(1f).clickable { tab = label }.padding(10.dp),
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
    if (cloudDialog || state.cloudSigningIn)
        CloudConnectionDialog(model, state.cloudSigningIn) { cloudDialog = false }
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
}

@Composable
private fun Sources(
    state: MapleState,
    onSelect: (Folder) -> Unit,
    onFolder: () -> Unit,
    onPhoto: () -> Unit,
    onCloud: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(vertical = 24.dp)) {
        Text(
            "Maple",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(20.dp),
        )
        MuiSection("Library") {
            Row(
                Modifier.fillMaxWidth().clickable(onClick = onPhoto).padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Image, null)
                Spacer(Modifier.width(12.dp))
                Text("Open photo…")
            }
            Row(
                Modifier.fillMaxWidth().clickable(onClick = onFolder).padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.CreateNewFolder, null)
                Spacer(Modifier.width(12.dp))
                Text("Add folder…")
            }
        }
        TextButton(onCloud, Modifier.padding(horizontal = 8.dp)) {
            Icon(Icons.Outlined.Cloud, null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Add Maple Cloud server")
        }
        Text(
            "SOURCES",
            style = MaterialTheme.typography.labelSmall,
            color = MapleColors.muted,
            modifier = Modifier.padding(20.dp),
        )
        LazyColumn {
            items(state.sources, key = { it.uri.toString() }) { folder ->
                Row(
                    Modifier.fillMaxWidth()
                        .background(
                            if (folder.uri == state.folder?.uri)
                                MapleColors.primary.copy(alpha = .15f)
                            else MapleColors.sidebar
                        )
                        .clickable { onSelect(folder) }
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (app.justmaple.aperture.cloud.CloudLibrary.isCloud(folder.uri))
                            Icons.Outlined.Cloud
                        else Icons.Outlined.Folder,
                        null,
                        tint = MapleColors.muted,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(folder.name)
                }
            }
        }
    }
}

@Composable
private fun BrowseGrid(
    model: MapleViewModel,
    state: MapleState,
    photos: List<Photo>,
    folders: List<Folder>,
    folderPicker: () -> Unit,
) {
    var columns by rememberSaveable { mutableIntStateOf(3) }
    if (state.loading)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = MapleColors.primary)
        }
    else if (photos.isEmpty() && folders.isEmpty())
        MuiEmptyState(
            if (state.folder == null) "Your library, in Maple" else "No photos here",
            "Open a folder of photos to browse, rate, and develop.",
            "Open folder",
            folderPicker,
        )
    else
        Column {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("${photos.size} photos", Modifier.weight(1f), color = MapleColors.muted)
                MuiIconButton("Larger thumbnails", Icons.Outlined.Add, enabled = columns > 1) {
                    columns--
                }
                MuiIconButton("Smaller thumbnails", Icons.Outlined.Remove, enabled = columns < 7) {
                    columns++
                }
            }
            LazyVerticalGrid(
                GridCells.Fixed(columns),
                contentPadding = PaddingValues(4.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                items(folders, key = { it.uri.toString() }) { folder ->
                    Column(
                        Modifier.aspectRatio(1f)
                            .background(MapleColors.raised)
                            .clickable { model.browse(folder) }
                            .padding(12.dp),
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Icon(Icons.Outlined.Folder, null)
                        Spacer(Modifier.height(8.dp))
                        Text(folder.name, maxLines = 2)
                    }
                }
                items(photos, key = { it.uri.toString() }) { photo ->
                    PhotoThumbnail(
                        photo,
                        model.library,
                        Modifier.aspectRatio(1f).clickable { model.open(photo) },
                        revision = state.document.original.takeIf { photo == state.selected },
                    )
                }
            }
        }
}

@Composable
private fun SettingsPanel(
    model: MapleViewModel,
    state: MapleState,
    onFolder: () -> Unit,
    onCloud: () -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        MuiSection("Editor") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Show filmstrip", Modifier.weight(1f))
                Switch(state.showFilmstrip, model::setFilmstrip)
            }
            Text(
                "Edits are saved automatically to XMP sidecars. Originals are always read-only.",
                color = MapleColors.muted,
            )
        }
        MuiSection("Cloud") {
            state.sources
                .filter { app.justmaple.aperture.cloud.CloudLibrary.isCloud(it.uri) }
                .forEach { server ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(server.name, Modifier.weight(1f))
                        TextButton({ model.disconnectCloud(server) }) { Text("Disconnect") }
                    }
                }
            TextButton(onCloud) { Text("Add Maple Cloud server") }
        }
        MuiSection("Sources") {
            state.sources
                .filterNot { app.justmaple.aperture.cloud.CloudLibrary.isCloud(it.uri) }
                .forEach { Text(it.name, Modifier.padding(vertical = 8.dp)) }
            TextButton(onFolder) { Text("Add folder…") }
        }
        MuiSection("About Maple") {
            Text("Maple for Android")
            Text("One shared Rust image core · Auto profile", color = MapleColors.muted)
        }
    }
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
