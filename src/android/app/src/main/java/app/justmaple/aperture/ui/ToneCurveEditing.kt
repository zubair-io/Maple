package app.justmaple.aperture.ui

import app.justmaple.aperture.data.CurveKnot
import app.justmaple.aperture.data.PointCurve
import kotlin.math.abs
import kotlin.math.hypot

/** Which point-curve family the plot edits (#2232); both may be authored on one photo. */
enum class ToneCurveFamily(val label: String, val curves: List<PointCurve>) {
    Scene(
        "Scene",
        listOf(PointCurve.SceneLuma, PointCurve.SceneRed, PointCurve.SceneGreen, PointCurve.SceneBlue),
    ),
    Display(
        "Display",
        listOf(PointCurve.DisplayLuma, PointCurve.DisplayRed, PointCurve.DisplayGreen, PointCurve.DisplayBlue),
    ),
}

fun ToneCurveFamily.channelLabel(index: Int): String =
    listOf(if (this == ToneCurveFamily.Scene) "Luma" else "Master", "R", "G", "B")[index]

/**
 * Keeps an authored list well formed for raw-core's curve stages: sorted by x,
 * inside the authoring domain, never two knots closer than [MIN_X_GAP]. Mirrors
 * Apple's `ToneCurveEditing`; the empty list is the identity everywhere.
 */
object ToneCurveEditing {
    const val MIN_X_GAP = 1f / 256f

    /** An identity curve materializes as the corner anchors, so the first knot has endpoints. */
    fun materialize(knots: List<CurveKnot>): List<CurveKnot> =
        if (knots.isEmpty()) listOf(CurveKnot(0f, 0f), CurveKnot(1f, 1f)) else knots.sortedBy { it.x }

    fun insert(knots: List<CurveKnot>, x: Float, y: Float): List<CurveKnot> {
        val list = materialize(knots)
        val px = x.coerceIn(0f, 1f)
        if (list.any { abs(it.x - px) < MIN_X_GAP }) return list
        return (list + CurveKnot(px, y.coerceIn(0f, 1f))).sortedBy { it.x }
    }

    /** Endpoints stay pinned to x = 0 and 1; interior knots stay strictly between neighbours. */
    fun move(knots: List<CurveKnot>, index: Int, x: Float, y: Float): List<CurveKnot> {
        val list = materialize(knots)
        if (index !in list.indices) return list
        val nextX =
            when (index) {
                0 -> 0f
                list.lastIndex -> 1f
                else -> minOf(maxOf(x.coerceIn(0f, 1f), list[index - 1].x + MIN_X_GAP), list[index + 1].x - MIN_X_GAP)
            }
        return list.mapIndexed { i, knot -> if (i == index) CurveKnot(nextX, y.coerceIn(0f, 1f)) else knot }
    }

    /** Endpoints are not deletable; removing back to the bare corners returns the identity. */
    fun remove(knots: List<CurveKnot>, index: Int): List<CurveKnot> {
        val list = materialize(knots)
        if (index <= 0 || index >= list.lastIndex) return list
        val next = list.filterIndexed { i, _ -> i != index }
        return if (isBareIdentity(next)) emptyList() else next
    }

    fun isBareIdentity(knots: List<CurveKnot>): Boolean =
        knots == listOf(CurveKnot(0f, 0f), CurveKnot(1f, 1f))

    /** The knot within [radius] authoring units of (x, y), or null. */
    fun hitTest(knots: List<CurveKnot>, x: Float, y: Float, radius: Float): Int? =
        materialize(knots)
            .withIndex()
            .minByOrNull { hypot(it.value.x - x, it.value.y - y) }
            ?.takeIf { hypot(it.value.x - x, it.value.y - y) <= radius }
            ?.index
}
