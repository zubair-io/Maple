package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Star
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel

@Composable
internal fun PreviewActions(model: MapleViewModel, state: MapleState) {
    // Wrap complete action groups when a tablet pane or phone cannot fit them.
    FlowRow(
        Modifier.fillMaxWidth().padding(8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val picked = state.document.attribute("papp:Flag") == "pick"
            MuiIconButton("Pick photo", Icons.Outlined.Flag, selected = picked) {
                model.attribute("papp:Flag", if (picked) null else "pick")
            }
            for (rating in 1..5) MuiIconButton(
                "Rate $rating stars",
                Icons.Outlined.Star,
                selected = state.document.rating >= rating,
            ) {
                model.attribute(
                    "xmp:Rating",
                    if (state.document.rating == rating) null else rating.toString(),
                )
            }
        }
    }
}
