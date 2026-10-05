"""Build (or verify) the reproducible Claude Desktop extension bundled with Maple."""

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "ClaudeDesktop"
DESTINATION = ROOT / "Sources/MapleMCPHTTP/Resources/Maple.mcpb"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = {
        str(path.relative_to(SOURCE)): path.read_bytes()
        for path in sorted(SOURCE.rglob("*"))
        if path.is_file()
    }
    if args.check:
        with ZipFile(DESTINATION) as archive:
            actual = {name: archive.read(name) for name in archive.namelist()}
        if actual != files:
            raise SystemExit(
                "Claude extension differs from source; run package-claude-extension.py"
            )
        print("Claude extension matches its source")
        return
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(DESTINATION, "w", compression=ZIP_DEFLATED) as archive:
        for name, contents in files.items():
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, contents)
    print(f"Built {DESTINATION.name}")


if __name__ == "__main__":
    main()
