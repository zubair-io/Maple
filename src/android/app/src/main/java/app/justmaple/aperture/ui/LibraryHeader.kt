package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun LibraryHeader(
    title: String,
    tablet: Boolean,
    onSources: () -> Unit,
    onSearch: () -> Unit,
    onSettings: () -> Unit,
    onFolder: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            MapleGlass(shape = CircleShape) {
                MuiIconButton("Sources", Icons.Outlined.Menu, onClick = onSources)
            }
            MapleGlass(shape = CircleShape) {
                Row(Modifier.padding(horizontal = 4.dp)) {
                    if (tablet) MuiIconButton("Search", Icons.Outlined.Search, onClick = onSearch)
                    MuiIconButton("Open folder", Icons.Outlined.CreateNewFolder, onClick = onFolder)
                    if (tablet)
                        MuiIconButton("Settings", Icons.Outlined.Settings, onClick = onSettings)
                }
            }
        }
        Text(
            title,
            Modifier.padding(start = 8.dp, top = 12.dp, bottom = 16.dp),
            fontSize = 32.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
