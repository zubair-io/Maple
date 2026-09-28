"""Fail closed when selected CI jobs did not succeed; validate intentional skips."""

import json
import os
import sys


def validate(needs, rules, event):
    if set(needs) != {"changes", *rules}:
        raise ValueError("Result gate must account for every dependency")
    if needs["changes"]["result"] != "success":
        raise ValueError("Change selection did not succeed")
    outputs = needs["changes"]["outputs"]
    for job, component in rules.items():
        if component == "always":
            selected = True
        elif component == "pr":
            selected = event == "pull_request"
        else:
            value = outputs.get(component)
            if value not in ("true", "false"):
                raise ValueError(f"Missing or invalid selection for {component}")
            selected = value == "true"
        expected = "success" if selected else "skipped"
        actual = needs[job]["result"]
        if actual != expected:
            raise ValueError(f"{job}: expected {expected}, got {actual}")
        print(f"{job}: {actual}")


if __name__ == "__main__":
    validate(
        json.loads(os.environ["NEEDS_JSON"]),
        dict(argument.split("=", 1) for argument in sys.argv[1:]),
        os.environ["GITHUB_EVENT_NAME"],
    )
