package app.justmaple.aperture.ui

import app.justmaple.aperture.generated.CanvasZoomAbi.OP_DOUBLE_TAP

/** One transition the Compose state sent to the zoom model. */
internal class ZoomCall(
    val op: Int,
    val args: DoubleArray,
    val viewport: Pair<Double, Double>,
    val image: Pair<Double, Double>,
)

/**
 * Records each transition instead of running the Rust model, which the JVM cannot load; a double
 * tap lands on 100% with the image dragged off-centre, every other op leaves the zoom as it is.
 */
internal class RecordingCanvasZoom : CanvasZoomNative {
    val calls = mutableListOf<ZoomCall>()

    override fun transition(state: DoubleArray, op: Int, a: Double, b: Double, c: Double,
        d: Double, viewportWidth: Double, viewportHeight: Double, imageWidth: Double,
        imageHeight: Double): Int {
        calls += ZoomCall(op, doubleArrayOf(a, b, c, d), viewportWidth to viewportHeight,
            imageWidth to imageHeight)
        if (op == OP_DOUBLE_TAP) {
            state[0] = 1.0
            state[1] = -120.0
            state[2] = 40.0
        }
        return 1
    }

    override fun query(state: DoubleArray, which: Int, viewportWidth: Double,
        viewportHeight: Double, imageWidth: Double, imageHeight: Double) = 1.0
}
