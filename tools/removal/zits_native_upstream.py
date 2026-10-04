"""#3941: execute pinned ZITS modules without its CUDA training wrapper.

The only upstream AST edit changes three literal .to(0) device arguments
in wireframe inference to CPU. Learned modules and sampling math are loaded
unchanged. Native FTR RGB stays f32; published uint8 structure proxies are
derived separately. This is a research adapter, not an admitted app model.
"""

import ast
import importlib
import json
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import skimage
import torch
import torch.nn.functional as F
import torchvision.transforms.functional as FF
import yaml
from native_probe_pixels import digest
from skimage.color import rgb2gray
from skimage.feature import canny

PINS_PATH = Path(__file__).with_name("zits-native-pins.json")


def verify(source, checkpoints):
    pins = json.loads(PINS_PATH.read_text())
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if (
        revision != pins["revision"]
        or subprocess.check_output(
            ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"],
            text=True,
        ).strip()
    ):
        raise ValueError("ZITS source revision or tracked contents changed")
    for name, pin in pins["source_sha256"].items():
        if digest(source / name) != pin:
            raise ValueError(f"ZITS source identity changed: {name}")
    for name, pin in pins["checkpoints"].items():
        path = checkpoints / name
        if path.stat().st_size != pin["bytes"] or digest(path) != pin["sha256"]:
            raise ValueError(f"ZITS checkpoint identity changed: {name}")
    return pins


def functions(source):
    tree = ast.parse((source / "single_image_test.py").read_text())
    names = {
        "load_masked_position_encoding",
        "resize",
        "to_tensor",
        "to_device",
        "wf_inference_test",
    }
    nodes = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    changes = 0
    for node in ast.walk(
        next(node for node in nodes if node.name == "wf_inference_test")
    ):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "to"
            and len(node.args) == 1
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == 0
        ):
            node.args[0] = ast.Constant(value="cpu")
            changes += 1
    if changes != 3 or len(nodes) != len(names):
        raise ValueError("Pinned upstream CPU adapter no longer matches")
    sampler = ast.parse((source / "src/utils.py").read_text())
    nodes += [
        node
        for node in sampler.body
        if isinstance(node, ast.FunctionDef) and node.name == "SampleEdgeLineLogits"
    ]
    scope = {"np": np, "cv2": cv2, "torch": torch, "FF": FF, "F": F, "skimage": skimage}
    exec(  # noqa: S102 — only functions from the SHA-verified upstream source
        compile(
            ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
            str(source / "single_image_test.py"),
            "exec",
        ),
        scope,
    )
    return scope


def load(source, checkpoints):
    verify(source, checkpoints)
    sys.path.insert(0, str(source))
    lama = importlib.import_module("src.models.LaMa")
    tsr = importlib.import_module("src.models.TSR_model")
    upsample = importlib.import_module("src.models.upsample")
    detector = importlib.import_module("src.lsm_hawp.detector")
    config = SimpleNamespace(
        **yaml.safe_load(
            (source / "config_list/config_ZITS_HR_places2.yml").read_text()
        )
    )
    transformer_config = tsr.EdgeLineGPTConfig(
        embd_pdrop=0.0,
        resid_pdrop=0.0,
        n_embd=256,
        block_size=32,
        attn_pdrop=0.0,
        n_layer=16,
        n_head=8,
    )
    models = {
        "generator": lama.ReZeroFFC(config),
        "str_encoder": lama.StructureEncoder(config),
        "transformer": tsr.EdgeLineGPT256RelBCE(transformer_config),
        "upsampler": upsample.StructureUpsampling(),
        "wireframe": detector.WireframeDetector(is_cuda=False),
    }
    loaded = {
        name: torch.load(checkpoints / name, map_location="cpu", weights_only=True)
        for name in json.loads(PINS_PATH.read_text())["checkpoints"]
    }
    states = {
        "generator": loaded["InpaintingModel_best_gen.pth"]["generator"],
        "str_encoder": loaded["InpaintingModel_best_gen.pth"]["str_encoder"],
        "transformer": loaded["best_transformer_places2.pth"]["model"],
        "upsampler": loaded["StructureUpsampling.pth"]["model"],
        "wireframe": loaded["best_lsm_hawp.pth"]["model"],
    }
    for name, model in models.items():
        model.load_state_dict(states[name], strict=True)
        model.eval().requires_grad_(False)
    # The released inference wrapper explicitly casts only TSR to half.
    models["transformer"].half()
    unchanged(models, states)
    return models, states, functions(source)


def unchanged(models, states):
    for name, model in models.items():
        if any(
            not torch.equal(value, states[name][key].to(value.dtype))
            for key, value in model.state_dict().items()
        ):
            raise ValueError(f"ZITS loaded evaluation state changed: {name}")


def predict(models, helpers, rgb, hole, output):
    native = torch.from_numpy(rgb.copy())
    mask = torch.from_numpy(hole.copy())
    # Match the published image-file path for guidance only. No native RGB
    # quantization or output upscaling; the FTR consumes full f32 source.
    proxy = np.floor(rgb[0].transpose(1, 2, 0) * 255 + 0.5).astype(np.uint8)
    mask_u8 = (hole[0, 0] * 255).astype(np.uint8)
    proxy256 = helpers["resize"](proxy, 256, 256)
    proxy512 = helpers["resize"](proxy, 512, 512)
    mask256 = cv2.resize(mask_u8, (256, 256), interpolation=cv2.INTER_AREA)
    mask512 = cv2.resize(mask_u8, (512, 512), interpolation=cv2.INTER_AREA)
    mask256[mask256 > 0] = 255
    mask512[mask512 > 0] = 255
    edge = canny(rgb2gray(proxy256), sigma=3.0, mask=None).astype(np.float64)
    rel_pos, _, direct = helpers["load_masked_position_encoding"](mask_u8)
    tensor = helpers["to_tensor"]
    phases = {}
    started = time.perf_counter()
    line = helpers["wf_inference_test"](
        models["wireframe"],
        tensor(proxy512).unsqueeze(0),
        h=256,
        w=256,
        masks=tensor(mask512).unsqueeze(0),
        valid_th=0.85,
        mask_th=0.85,
    )
    phases["wireframe_seconds"] = time.perf_counter() - started
    started = time.perf_counter()
    edge_pred, line_pred = helpers["SampleEdgeLineLogits"](
        models["transformer"],
        context=[
            tensor(proxy256, norm=True).unsqueeze(0),
            tensor(edge).unsqueeze(0),
            line,
        ],
        mask=tensor(mask256).unsqueeze(0),
        iterations=5,
        add_v=0.05,
        mul_v=4,
        device="cpu",
    )
    phases["structure_seconds"] = time.perf_counter() - started
    edge_pred, line_pred = edge_pred.float(), line_pred.float()
    for name, values in (
        ("edge256", edge_pred),
        ("line256", line_pred),
        ("known-line256", line),
    ):
        values.numpy().astype("<f4").tofile(output / f"{name}.f32")
    started = time.perf_counter()
    while edge_pred.shape[2] < rgb.shape[2]:
        edge_pred = torch.sigmoid((models["upsampler"](edge_pred)[0] + 2) * 2)
        line_pred = torch.sigmoid((models["upsampler"](line_pred)[0] + 2) * 2)
    edge_pred = F.interpolate(
        edge_pred, size=rgb.shape[2:], mode="bilinear", align_corners=False
    )
    line_pred = F.interpolate(
        line_pred, size=rgb.shape[2:], mode="bilinear", align_corners=False
    )
    phases["upsampler_seconds"] = time.perf_counter() - started
    for name, values in (("edge-native", edge_pred), ("line-native", line_pred)):
        values.numpy().astype("<f4").tofile(output / f"{name}.f32")
    started = time.perf_counter()
    features, position, direction = models["str_encoder"](
        torch.cat([edge_pred, line_pred, mask], dim=1),
        torch.from_numpy(rel_pos.astype(np.int64))[None],
        torch.from_numpy(direct.astype(np.int64))[None],
    )
    predicted = models["generator"](
        torch.cat([native * (1 - mask), mask], dim=1).float(),
        position,
        direction,
        features,
    )
    phases["texture_seconds"] = time.perf_counter() - started
    return predicted.numpy(), phases
