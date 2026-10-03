"""#3941: Apple bundled calibration fixtures must equal the shared Rust originals."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "test-fixtures/removal/calibration"
APPLE = (
    ROOT
    / "src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/removal/calibration"
)


def verify(canonical, bundled):
    expected = {
        p.relative_to(canonical): p for p in canonical.rglob("*") if p.is_file()
    }
    actual = {p.relative_to(bundled): p for p in bundled.rglob("*") if p.is_file()}
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
    count = verify(CANONICAL, APPLE)
    print(f"All {count} Apple calibration fixture copies match shared Rust bytes.")
