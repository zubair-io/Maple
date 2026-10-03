"""#3941: bounded RGB-guide PatchMatch experiment, never a Keep implementation.

The correspondence grid is four source pixels; each vote copies actual native
source pixels from a known 12x12 support. The coarse guide supplies structure
only. This independently authored translation-only RGB diagnostic does not
implement the published method's segmentation/depth guides or auto-curation.
"""

import numpy as np

STRIDE = 4
ITERATIONS = 5
SEED = 3941


def blocks(image):
    height, width, channels = image.shape
    return image.reshape(
        height // STRIDE, STRIDE, width // STRIDE, STRIDE, channels
    ).transpose(0, 2, 1, 3, 4)


def descriptor(image):
    padded = np.pad(image, ((1, 1), (1, 1), (0, 0)), mode="reflect")
    height, width = image.shape[:2]
    return np.concatenate(
        [padded[y : y + height, x : x + width] for y in range(3) for x in range(3)],
        axis=2,
    )


def refine(source, hole, guide):
    """Return native votes plus source-block correspondence; no RGB upsampling."""
    if (
        source.dtype != np.float32
        or guide.dtype != np.float32
        or source.shape != guide.shape
        or source.ndim != 3
        or source.shape[2] != 3
    ):
        raise ValueError("Expected matching float32 RGB source and guide")
    height, width = source.shape[:2]
    if (
        min(height, width) < 16
        or max(height, width) > 2048
        or height % STRIDE
        or width % STRIDE
    ):
        raise ValueError("Experimental context must fit 2048 and four-pixel blocks")
    if hole.shape != (height, width) or hole.dtype != np.bool_ or not hole.any():
        raise ValueError("Expected a nonempty binary source-space hole")
    if not np.isfinite(source).all() or not np.isfinite(guide).all():
        raise ValueError("Non-finite image")
    if min(source.min(), guide.min()) < 0 or max(source.max(), guide.max()) > 1:
        raise ValueError("Only the diagnostic SDR domain is supported")
    grid_h, grid_w = height // STRIDE, width // STRIDE
    selected = hole.reshape(grid_h, STRIDE, grid_w, STRIDE).any(axis=(1, 3))
    expanded = np.pad(selected, 1, constant_values=True)
    valid = np.ones_like(selected)
    for dy in range(3):
        for dx in range(3):
            valid &= ~expanded[dy : dy + grid_h, dx : dx + grid_w]
    donors = np.argwhere(valid)
    if len(donors) == 0:
        raise ValueError("No complete known native donor support")
    source_blocks = blocks(source)
    # Known guide samples are derived from the source, never from the model.
    guide_grid = blocks(guide).mean(axis=(2, 3))
    guide_grid[~selected] = source_blocks.mean(axis=(2, 3))[~selected]
    features = descriptor(guide_grid)
    ty, tx = np.nonzero(selected)
    target = features[ty, tx]
    rng = np.random.default_rng(SEED)
    yy, xx = np.indices(selected.shape, dtype=np.int32)
    sampled = donors[rng.integers(len(donors), size=len(ty))]
    yy[ty, tx], xx[ty, tx] = sampled[:, 0], sampled[:, 1]
    scores = np.square(target - features[yy[ty, tx], xx[ty, tx]]).mean(axis=1)
    initial_error = float(scores.mean())

    def consider(cy, cx):
        cy = np.clip(cy, 0, grid_h - 1)
        cx = np.clip(cx, 0, grid_w - 1)
        eligible = valid[cy, cx]
        distances = np.square(target - features[cy, cx]).mean(axis=1)
        improved = eligible & (distances < scores)
        yy[ty[improved], tx[improved]] = cy[improved]
        xx[ty[improved], tx[improved]] = cx[improved]
        scores[improved] = distances[improved]

    for iteration in range(ITERATIONS):
        direction = 1 if iteration % 2 == 0 else -1
        for dy, dx in [
            (0, direction),
            (direction, 0),
            (0, -direction),
            (-direction, 0),
        ]:
            ny, nx = np.clip(ty + dy, 0, grid_h - 1), np.clip(tx + dx, 0, grid_w - 1)
            consider(yy[ny, nx] - dy, xx[ny, nx] - dx)
        radius = max(grid_h, grid_w)
        while radius >= 1:
            cy = yy[ty, tx] + rng.integers(-radius, radius + 1, size=len(ty))
            cx = xx[ty, tx] + rng.integers(-radius, radius + 1, size=len(ty))
            consider(cy, cx)
            radius //= 2
    # Vote native 12x12 donor pixels into overlapping 12x12 target supports.
    # A target block can receive up to nine aligned native block votes.
    total = np.zeros_like(source_blocks)
    weight = np.zeros(selected.shape, dtype=np.float32)
    for dy in [-1, 0, 1]:
        for dx in [-1, 0, 1]:
            dest_y, dest_x = ty + dy, tx + dx
            inside = (
                (dest_y >= 0) & (dest_y < grid_h) & (dest_x >= 0) & (dest_x < grid_w)
            )
            dest_y, dest_x = dest_y[inside], dest_x[inside]
            from_y, from_x = (
                yy[ty[inside], tx[inside]] + dy,
                xx[ty[inside], tx[inside]] + dx,
            )
            vote_weight = np.float32(1 / (1 + abs(dy) + abs(dx)))
            total[dest_y, dest_x] += source_blocks[from_y, from_x] * vote_weight
            weight[dest_y, dest_x] += vote_weight
    voted = total / np.maximum(weight[:, :, None, None, None], np.float32(1e-20))
    generated = voted.transpose(0, 2, 1, 3, 4).reshape(source.shape)
    result = source.copy()
    result[hole] = generated[hole]
    if not np.isfinite(result).all() or not (weight[selected] > 0).all():
        raise ValueError("Invalid native vote result")
    return result, {
        "grid_stride_source_pixels": STRIDE,
        "donor_support_source_pixels": 3 * STRIDE,
        "iterations": ITERATIONS,
        "seed": SEED,
        "selected_source_pixels": int(hole.sum()),
        "selected_blocks": int(selected.sum()),
        "valid_donor_blocks": int(valid.sum()),
        "invalid_donors": int((~valid[yy[ty, tx], xx[ty, tx]]).sum()),
        "initial_guide_mse": initial_error,
        "final_guide_mse": float(scores.mean()),
        "outside_changed_samples": int(
            np.count_nonzero(result[~hole] != source[~hole])
        ),
        "final_pixels": "Weighted native source copies; coarse guide contributes no RGB pixels",
        "release_qualified": False,
    }
