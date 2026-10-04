"""#4183: verify actual clean/incremental Apple build provenance and signatures."""

import argparse
import datetime
import hashlib
import json
import plistlib
import re
from pathlib import Path

CASES = {
    "clean-debug": None,
    "incremental-stable": False,
    "incremental-prerelease": True,
}


def checked_bytes(path, digest):
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Evidence bytes differ from recorded digest")
    return data


def verify(manifests):
    rows = [row for path in manifests for row in json.loads(path.read_text())]
    expected = {(platform, case) for platform in ["mac", "ios"] for case in CASES}
    actual = [(row["platform"], row["case"]) for row in rows]
    if len(actual) != 6 or set(actual) != expected:
        raise ValueError("Require all six distinct clean/incremental build cases")
    heads = {row["testedHead"] for row in rows}
    if len(heads) != 1 or not re.fullmatch(r"[0-9a-f]{40}", next(iter(heads))):
        raise ValueError("All builds must identify one complete tested commit")
    for row in rows:
        if row["buildExit"] != 0 or row["codesignExit"] != 0:
            raise ValueError("Build and deep signature verification must succeed")
        log = checked_bytes(row["log"], row["logSHA256"]).decode()
        if "** BUILD SUCCEEDED **" not in log or "** BUILD FAILED **" in log:
            raise ValueError("Missing successful terminal build")
        info = plistlib.loads(checked_bytes(row["plist"], row["plistSHA256"]))
        if info.get("MapleBuildGitSHA") != row["testedHead"][:12]:
            raise ValueError("Missing or stale final provenance SHA")
        expected_early = CASES[row["case"]]
        if row["expectedEarlyFeatures"] is not expected_early:
            raise ValueError("Build scenario disagrees with its expected early policy")
        if info.get("MapleEarlyFeatures") is not expected_early:
            raise ValueError(
                "Final early-feature policy differs from the build scenario"
            )
        stamp = datetime.datetime.fromisoformat(
            info["MapleBuildDate"].replace("Z", "+00:00")
        )
        start = datetime.datetime.fromisoformat(row["started"]).replace(microsecond=0)
        end = datetime.datetime.fromisoformat(row["ended"])
        if not start <= stamp <= end or stamp.utcoffset() != datetime.timedelta(0):
            raise ValueError("Final timestamp must belong to this actual UTC build")
        lines = log.splitlines()
        stamps = [
            i
            for i, line in enumerate(lines)
            if line.startswith("PhaseScriptExecution Stamp")
        ]
        generated = [
            i
            for i, line in enumerate(lines)
            if line.startswith("ProcessInfoPlistFile ")
            and "/Maple.app/" in line
            and "(in target 'Maple'" in line
        ]
        signed = [
            i
            for i, line in enumerate(lines)
            if line.startswith("CodeSign ") and "/Maple.app (in target 'Maple'" in line
        ]
        if len(stamps) != 1 or not signed or stamps[0] >= min(signed):
            raise ValueError("Provenance stamp must precede final app signing")
        if generated and max(generated) >= stamps[0]:
            raise ValueError("Info.plist processing must precede provenance stamping")
        if row["case"] == "clean-debug" and not generated:
            raise ValueError("Clean build must actually generate the app Info.plist")
    return {
        "testedHead": next(iter(heads)),
        "verifiedCases": actual,
        "buildsPassed": 6,
        "finalPlistsAndDeepSignaturesVerified": 6,
        "orderedBeforeSigning": True,
        "releaseQualified": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests", type=Path, nargs=2)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Choose a fresh output")
    report = verify(args.manifests)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
