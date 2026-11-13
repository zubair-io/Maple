"""#5159: Apple bundled removal fixtures must equal the shared Rust originals."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "test-fixtures/removal"
APPLE = ROOT / "src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/removal"
# SwiftPM resources cannot reach outside the package, so `basic/` is mirrored at
# the Apple fixture root and `calibration/` keeps its own directory.
PAIRS = (
    (CANONICAL / "basic", APPLE, False),
    (CANONICAL / "calibration", APPLE / "calibration", True),
)


def _files(directory, recursive):
    paths = directory.rglob("*") if recursive else directory.glob("*")
    return {p.relative_to(directory): p for p in paths if p.is_file()}


def verify(canonical, bundled, recursive=True):
    expected = _files(canonical, recursive)
    actual = _files(bundled, recursive)
    if not expected or expected.keys() != actual.keys():
        missing, extra = (
            expected.keys() - actual.keys(),
            actual.keys() - expected.keys(),
        )
        raise ValueError(
            f"Removal fixture copies differ: missing={sorted(missing)}, extra={sorted(extra)}"
        )
    changed = [
        str(name)
        for name, path in expected.items()
        if path.read_bytes() != actual[name].read_bytes()
    ]
    if changed:
        raise ValueError(
            f"Apple removal fixture bytes differ from shared Rust: {', '.join(changed)}"
        )
    return len(expected)


if __name__ == "__main__":
    count = sum(verify(*pair) for pair in PAIRS)
    print(f"All {count} Apple removal fixture copies match shared Rust bytes.")
