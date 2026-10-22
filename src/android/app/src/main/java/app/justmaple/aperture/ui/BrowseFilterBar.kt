package app.justmaple.aperture.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.XmpDocument

val GRID_COLUMN_TIERS = listOf(1, 2, 3, 4, 5, 7)

fun nextGridColumnsForPinch(current: Int, zoom: Float): Int {
    val tiers = GRID_COLUMN_TIERS
    val clamped = current.coerceIn(tiers.first(), tiers.last())
    return when {
        zoom >= 1.2f -> tiers.lastOrNull { it < clamped } ?: tiers.first()
        zoom <= 0.85f -> tiers.firstOrNull { it > clamped } ?: tiers.last()
        else -> clamped
    }
}

fun flagToPick(flag: String?): Int =
    when (flag) {
        "pick" -> 1
        "reject" -> -1
        else -> 0
    }

fun pickToFlag(pick: Int): String? =
    when (pick) {
        1 -> "pick"
        -1 -> "reject"
        else -> null
    }

enum class BrowseFilter(val label: String, val testTag: String) {
    All("All", "grid-filter-all"),
    Picks("Picks", "grid-filter-picks"),
    Unrejected("Unrejected", "grid-filter-unrejected"),
    ThreePlus("3+ ★", "grid-filter-3plus"),
    FourPlus("4+ ★", "grid-filter-4plus"),
}

enum class BrowseSort(val label: String) {
    Name("Name"),
    Rating("Rating"),
}

data class PhotoCulling(val pick: Int = 0, val rating: Int = 0) {
    fun matches(filter: BrowseFilter): Boolean =
        when (filter) {
            BrowseFilter.All -> true
            BrowseFilter.Picks -> pick == 1
            BrowseFilter.Unrejected -> pick >= 0
            BrowseFilter.ThreePlus -> rating >= 3
            BrowseFilter.FourPlus -> rating >= 4
        }
}

fun cullingOf(document: XmpDocument): PhotoCulling =
    PhotoCulling(flagToPick(document.attribute("papp:Flag")), document.rating)

fun applyBrowseCulling(
    photos: List<Photo>,
    culling: Map<String, PhotoCulling>,
    filter: BrowseFilter,
    sort: BrowseSort,
): List<Photo> {
    val kept =
        if (filter == BrowseFilter.All) photos
        else photos.filter { (culling[it.uri.toString()] ?: PhotoCulling()).matches(filter) }
    return when (sort) {
        BrowseSort.Name -> kept.sortedBy { it.name.lowercase() }
        BrowseSort.Rating ->
            kept.sortedWith(
                compareByDescending<Photo> { (culling[it.uri.toString()] ?: PhotoCulling()).rating }
                    .thenBy { it.name.lowercase() }
            )
    }
}

@Composable
fun BrowseFilterBar(
    filter: BrowseFilter,
    onFilter: (BrowseFilter) -> Unit,
    sort: BrowseSort,
    onSort: (BrowseSort) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BrowseFilter.entries.forEach { entry ->
            FilterChip(
                selected = filter == entry,
                onClick = { onFilter(entry) },
                label = { Text(entry.label, fontSize = 12.sp) },
                modifier = Modifier.testTag(entry.testTag),
            )
        }
        Spacer(Modifier.weight(1f))
        val next = if (sort == BrowseSort.Name) BrowseSort.Rating else BrowseSort.Name
        AssistChip(
            onClick = { onSort(next) },
            label = { Text("Sort: ${sort.label}", fontSize = 12.sp) },
            modifier = Modifier.testTag("grid-sort-toggle"),
        )
    }
}

@Composable
fun CullingBadges(pick: Int, rating: Int, modifier: Modifier = Modifier) {
    Row(
        modifier.padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (pick == -1)
            Badge(containerColor = MapleColors.error) {
                Text("Rejected", fontSize = 10.sp, modifier = Modifier.padding(horizontal = 2.dp))
            }
        if (pick == 1)
            Icon(
                Icons.Outlined.Check,
                "Picked",
                tint = MapleColors.primary,
                modifier = Modifier.size(14.dp),
            )
        if (rating > 0)
            Text(
                "★ $rating",
                color = MapleColors.star,
                fontSize = 10.sp,
            )
        if (pick == -1)
            Icon(
                Icons.Outlined.Close,
                "Rejected",
                tint = MapleColors.error,
                modifier = Modifier.size(14.dp),
            )
    }
}
