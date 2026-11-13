"""Exact synthetic queue boundaries, pagination and failure paths."""

import json
import unittest
from unittest.mock import patch

from ci_group_bodies import group_bodies, read_entries

BASE, FIRST, LAST, OTHER = (character * 40 for character in "abcd")


def entry(base, head, number, body):
    return {
        "baseCommit": {"oid": base},
        "headCommit": {"oid": head},
        "pullRequest": {"number": number, "body": body},
    }


def page(entries, more=False, cursor=None):
    return json.dumps(
        {
            "data": {
                "repository": {
                    "mergeQueue": {
                        "entries": {
                            "nodes": entries,
                            "pageInfo": {"hasNextPage": more, "endCursor": cursor},
                        }
                    }
                }
            }
        }
    )


class GroupBodiesTests(unittest.TestCase):
    def test_all_prs_in_exact_chain_including_marker_on_earlier_pr(self):
        entries = [
            entry(BASE, FIRST, 1, "RE-BASELINE: earlier"),
            entry(FIRST, LAST, 2, "later"),
            entry(LAST, OTHER, 3, "not included"),
        ]
        self.assertEqual(
            group_bodies(entries, BASE, LAST), "RE-BASELINE: earlier\nlater"
        )

    def test_snapshot_moved_or_lacks_an_earlier_entry_fails_closed(self):
        for entries in [
            [],
            [entry(FIRST, LAST, 2, "later")],
            [entry(BASE, FIRST, 1, "earlier")],
            [entry(LAST, LAST, 2, "cycle")],
        ]:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                group_bodies(entries, BASE, LAST)

    def test_ambiguous_or_incomplete_entries_fail_closed(self):
        for entries in [
            [entry(BASE, LAST, 1, "a"), entry(BASE, LAST, 2, "b")],
            [{"headCommit": {"oid": LAST}}],
        ]:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                group_bodies(entries, BASE, LAST)

    @patch("ci_group_bodies.subprocess.check_output")
    def test_pagination_keeps_every_entry(self, run):
        first = entry(BASE, FIRST, 1, "earlier")
        last = entry(FIRST, LAST, 2, "later")
        run.side_effect = [page([first], True, "next"), page([last])]
        self.assertEqual(read_entries("owner/repo", "main"), [first, last])
        self.assertIn("after=next", run.call_args.args[0])

    @patch("ci_group_bodies.subprocess.check_output")
    def test_errors_or_disabled_queue_never_return_partial_bodies(self, run):
        for response in [
            '{"errors":[{"message":"denied"}]}',
            '{"data":{"repository":{"mergeQueue":null}}}',
            page([], True, None),
        ]:
            run.return_value = response
            with (
                self.subTest(response=response),
                self.assertRaises((ValueError, TypeError)),
            ):
                read_entries("owner/repo", "main")


if __name__ == "__main__":
    unittest.main()
