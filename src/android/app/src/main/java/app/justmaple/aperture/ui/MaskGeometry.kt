package app.justmaple.aperture.ui

import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.MaskShape
import app.justmaple.aperture.data.RadialMask
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** The selected layer's drag handles (`mask-overlay.md`), with Apple's identifiers. */
enum class MaskHandle(val id: String, val label: String) {
    LinearStart("linearStart", "gradient start"),
    LinearEnd("linearEnd", "gradient end"),
    LinearBody("linearBody", "gradient"),
    RadialCenter("radialCenter", "center"),
    RadialRadiusX("radialRadiusX", "horizontal radius"),
    RadialRadiusY("radialRadiusY", "vertical radius"),
    RadialRotate("radialRotate", "rotation"),
}

/** Smallest half-axis a radius handle can drag to, in normalized units. */
private const val MIN_RADIUS = 0.01f
/** Where the rotation pin sits along the local x axis, as a multiple of `rx`. */
private const val ROTATE_HANDLE_FACTOR = 1.3f

/** Endpoints and radii win over bodies and centres, so a tiny mask stays resizable. */
private val HIT_PRECEDENCE =
    listOf(
        MaskHandle.LinearStart, MaskHandle.LinearEnd, MaskHandle.RadialRotate, MaskHandle.RadialRadiusX,
        MaskHandle.RadialRadiusY, MaskHandle.RadialCenter, MaskHandle.LinearBody,
    )

fun defaultLinearMask() = LinearMask(MaskPoint(.5f, .15f), MaskPoint(.5f, .55f), .5f)

/** Centred; `aspect` (w/h of the full frame) pre-corrects the radii so it reads as a circle. */
fun defaultRadialMask(aspect: Float): RadialMask {
    val ratio = aspect.takeIf { it.isFinite() && it > 0f } ?: 1f
    return RadialMask(MaskPoint(.5f, .5f), MaskPoint(.25f, .25f * ratio), 0f, .5f, false)
}

fun maskHandles(shape: MaskShape): List<Pair<MaskHandle, MaskPoint>> =
    when (shape) {
        is LinearMask ->
            listOf(
                MaskHandle.LinearStart to shape.start,
                MaskHandle.LinearEnd to shape.end,
                MaskHandle.LinearBody to MaskPoint((shape.start.x + shape.end.x) / 2, (shape.start.y + shape.end.y) / 2),
            )
        is RadialMask -> {
            val (c, r) = shape.center to shape.radii
            val (cosA, sinA) = cos(shape.angle) to sin(shape.angle)
            listOf(
                MaskHandle.RadialCenter to c,
                MaskHandle.RadialRadiusX to MaskPoint(c.x + r.x * cosA, c.y + r.x * sinA),
                MaskHandle.RadialRadiusY to MaskPoint(c.x - r.y * sinA, c.y + r.y * cosA),
                MaskHandle.RadialRotate to
                    MaskPoint(c.x + r.x * ROTATE_HANDLE_FACTOR * cosA, c.y + r.x * ROTATE_HANDLE_FACTOR * sinA),
            )
        }
        else -> emptyList()
    }

/** Points along the ellipse boundary, or the gradient axis. */
fun maskOutline(shape: MaskShape, samples: Int = 72): List<MaskPoint> =
    when (shape) {
        is LinearMask -> listOf(shape.start, shape.end)
        is RadialMask -> {
            val (cosA, sinA) = cos(shape.angle) to sin(shape.angle)
            (0..samples).map { i ->
                val phi = i * 2 * Math.PI.toFloat() / samples
                val lx = shape.radii.x * cos(phi)
                val ly = shape.radii.y * sin(phi)
                MaskPoint(shape.center.x + lx * cosA - ly * sinA, shape.center.y + lx * sinA + ly * cosA)
            }
        }
        else -> emptyList()
    }

/** The handle whose on-screen position lies within [radius] of [at], if any. */
fun hitMaskHandle(shape: MaskShape, at: MaskPoint, radius: Float, toScreen: (MaskPoint) -> MaskPoint): MaskHandle? {
    val handles = maskHandles(shape).toMap()
    val target = toScreen(at)
    return HIT_PRECEDENCE.firstOrNull { handle ->
        handles[handle]?.let(toScreen)?.let { kotlin.math.hypot(it.x - target.x, it.y - target.y) <= radius } == true
    }
}

/** [start] with [handle] dragged to [point]; [anchor] is where the drag began. */
fun dragMaskHandle(start: MaskShape, handle: MaskHandle, point: MaskPoint, anchor: MaskPoint): MaskShape {
    if (!point.x.isFinite() || !point.y.isFinite()) return start
    return when (start) {
        is LinearMask ->
            when (handle) {
                MaskHandle.LinearStart -> start.copy(start = point)
                MaskHandle.LinearEnd -> start.copy(end = point)
                MaskHandle.LinearBody -> {
                    val dx = clampDelta(point.x - anchor.x, min(start.start.x, start.end.x), max(start.start.x, start.end.x))
                    val dy = clampDelta(point.y - anchor.y, min(start.start.y, start.end.y), max(start.start.y, start.end.y))
                    start.copy(
                        start = MaskPoint(start.start.x + dx, start.start.y + dy),
                        end = MaskPoint(start.end.x + dx, start.end.y + dy),
                    )
                }
                else -> start
            }
        is RadialMask -> {
            val dx = point.x - start.center.x
            val dy = point.y - start.center.y
            val (cosA, sinA) = cos(start.angle) to sin(start.angle)
            when (handle) {
                MaskHandle.RadialCenter -> start.copy(center = point)
                MaskHandle.RadialRadiusX -> start.copy(radii = start.radii.copy(x = max(MIN_RADIUS, abs(dx * cosA + dy * sinA))))
                MaskHandle.RadialRadiusY -> start.copy(radii = start.radii.copy(y = max(MIN_RADIUS, abs(-dx * sinA + dy * cosA))))
                MaskHandle.RadialRotate -> start.copy(angle = atan2(dy, dx))
                else -> start
            }
        }
        else -> start
    }
}

/** The largest move toward [delta] that keeps the span `[lo, hi]` inside `[0, 1]`. */
private fun clampDelta(delta: Float, lo: Float, hi: Float) = min(1 - hi, max(-lo, delta))

/**
 * The row-major projective map `[m0 … m8]` from `mask_frame`: crop and manual
 * geometry together, so a keystone's perspective divide is part of every point.
 * A point on or behind the horizon maps to NaN, which hit tests and drags ignore.
 */
class MaskProjection(private val m: DoubleArray) {
    init {
        require(m.size == 9) { "A mask projection has nine entries" }
    }

    fun apply(p: MaskPoint): MaskPoint {
        val w = m[6] * p.x + m[7] * p.y + m[8]
        if (abs(w) < 1e-9) return MaskPoint(Float.NaN, Float.NaN)
        return MaskPoint(
            ((m[0] * p.x + m[1] * p.y + m[2]) / w).toFloat(),
            ((m[3] * p.x + m[4] * p.y + m[5]) / w).toFloat(),
        )
    }

    /** The inverse via the adjugate, or null when the map is singular. */
    fun inverse(): MaskProjection? {
        val c0 = m[4] * m[8] - m[5] * m[7]
        val c1 = m[5] * m[6] - m[3] * m[8]
        val c2 = m[3] * m[7] - m[4] * m[6]
        val det = m[0] * c0 + m[1] * c1 + m[2] * c2
        if (!det.isFinite() || abs(det) < 1e-12) return null
        return MaskProjection(
            doubleArrayOf(
                c0, m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
                c1, m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
                c2, m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
            ).map { it / det }.toDoubleArray()
        )
    }

    /** `[m0 … m8]`, row-major. */
    val values: DoubleArray
        get() = m.copyOf()
}
