"""Read every PR body in an exact merge-group commit chain; fail closed."""

import argparse
import json
import re
import subprocess

QUERY = """
query($owner:String!,$name:String!,$branch:String!,$after:String) {
  repository(owner:$owner,name:$name) {
    mergeQueue(branch:$branch) {
      entries(first:100,after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes { baseCommit { oid } headCommit { oid } pullRequest { number body } }
      }
    }
  }
}
"""


def read_entries(repository, branch):
    owner, name = repository.split("/", 1)
    cursor = None
    entries = []
    for _ in range(100):
        command = [
            "gh",
            "api",
            "graphql",
            "-f",
            f"query={QUERY}",
            "-f",
            f"owner={owner}",
            "-f",
            f"name={name}",
            "-f",
            f"branch={branch}",
        ]
        if cursor:
            command.extend(["-f", f"after={cursor}"])
        payload = json.loads(subprocess.check_output(command, text=True))
        if payload.get("errors"):
            raise ValueError("Could not read merge queue")
        connection = payload["data"]["repository"]["mergeQueue"]["entries"]
        entries.extend(connection["nodes"])
        page = connection["pageInfo"]
        if not page["hasNextPage"]:
            return entries
        if not page["endCursor"] or page["endCursor"] == cursor:
            raise ValueError("Merge queue pagination did not advance")
        cursor = page["endCursor"]
    raise ValueError("Merge queue pagination exceeded its bound")


def group_bodies(entries, base, head):
    for oid in (base, head):
        if not re.fullmatch(r"[0-9a-f]{40}", oid):
            raise ValueError("Invalid group commit")
    by_head = {}
    for entry in entries:
        oid = (entry.get("headCommit") or {}).get("oid")
        if not oid:
            continue  # Entries not yet built cannot belong to this built head.
        if oid in by_head:
            raise ValueError("Ambiguous merge queue head")
        by_head[oid] = entry
    bodies = []
    visited = set()
    current = head
    while current != base:
        if current in visited or current not in by_head:
            raise ValueError("Exact merge-group chain is no longer in the queue")
        visited.add(current)
        entry = by_head[current]
        pr = entry.get("pullRequest")
        parent = (entry.get("baseCommit") or {}).get("oid")
        if not pr or not isinstance(pr.get("number"), int) or not parent:
            raise ValueError("Incomplete merge queue entry")
        bodies.append(pr.get("body") or "")
        current = parent
    if not bodies:
        raise ValueError("Empty merge group")
    return "\n".join(reversed(bodies))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repository", "branch", "base", "head"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    try:
        print(
            group_bodies(
                read_entries(args.repository, args.branch), args.base, args.head
            )
        )
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Cannot validate queued PR budget markers: {error}\n")


if __name__ == "__main__":
    main()
