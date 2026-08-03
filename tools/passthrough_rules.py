"""Naming and exclusion rules for collapsing pass-through folder chains.

Collapsing a chain has to answer two questions: may this chain be touched at
all, and if so what should the surviving folder be called. Both answers are
library conventions rather than properties of the filesystem, so they live here
rather than in the audit that finds the chains.

Names that carry no information -- ``DCIM``, ``jpg``, ``100CANON``, ``001`` --
lose to the folder above them, because the outer name is the one a person
chose. When the folder above is equally uninformative there is nothing worth
keeping and the result is ``Misc``.
"""

from __future__ import annotations

import os
import re

# A name that describes a format, a camera, or a sequence number rather than
# any content. Substring match, so 100CANON and CanonRaw both qualify.
BUCKET_SUBSTRING = re.compile(r"(dcim|jpe?g|canon)", re.I)
BUCKET_NUMERIC = re.compile(r"^\d+$")

# A capture date. Unlike a bucket name this is real information, so a chain
# ending in one is left alone entirely rather than renamed.
DATE_NAME = re.compile(r"^\d{1,4}[-._]\d{1,2}([-._]\d{1,2})?$")

# A year folder. The library is organised by year, so a year is structure
# rather than a redundant wrapper and is never removable -- at the library root
# or under a parallel tree like _duplicates/.
YEAR_NAME = re.compile(r"^(19|20)\d{2}$")

# Application-managed layouts. The app requires the directory structure, so
# reorganising it breaks the project rather than tidying it.
PROTECTED_SUBPATHS = (
    "2007/College/Grad School/Fashion Project",
    "2007/College/Grad School/_A Mirror Dimly",
)
PROTECTED_COMPONENT = re.compile(r"\.lrdata", re.I)

FALLBACK_NAME = "Misc"

# Shortest ancestor name worth inheriting. A fragment like "Un" or "cf" says no
# more than Misc does, so the search passes over it. This applies only when
# looking upward for a replacement -- a folder actually named "bmw" or "Sky"
# keeps its own name, since the rule is about what is worth inheriting, not
# about what is worth having.
MIN_INHERITABLE_LENGTH = 4


def is_bucket(name: str) -> bool:
    """True when ``name`` describes a container rather than its contents."""
    return bool(BUCKET_SUBSTRING.search(name) or BUCKET_NUMERIC.match(name))


def is_date(name: str) -> bool:
    """True when ``name`` looks like a capture date such as ``08-26``."""
    return bool(DATE_NAME.match(name))


def skip_reason(rel_terminal: str, rel_parent: str, link_names: list[str]) -> str | None:
    """Why this chain must not be collapsed, or None if it may be.

    ``rel_terminal`` and ``rel_parent`` are library-relative paths; the parent
    is empty for a chain that starts at a top-level folder.
    """
    terminal_name = os.path.basename(rel_terminal)

    if not rel_parent:
        # The redundant link is a top-level folder. Collapsing it would lift a
        # year's contents to the library root and lose the year itself.
        return f"would collapse the top-level folder {link_names[0]!r}"

    year_links = [n for n in link_names if YEAR_NAME.match(n)]
    if year_links:
        # Equally true one level down: _duplicates/2009/Misc must not become
        # _duplicates/Misc, which would both lose the year and collide with
        # every other year's Misc.
        return f"would remove the year folder {year_links[0]!r}"

    if any(PROTECTED_COMPONENT.search(part) for part in rel_terminal.split(os.sep)):
        return "inside a .lrdata package"

    if any(rel_terminal.startswith(p + os.sep) or rel_terminal == p for p in PROTECTED_SUBPATHS):
        return "inside a protected project tree"

    if is_date(terminal_name):
        return f"terminal {terminal_name!r} is a date"

    return None


def resolve_name(terminal_name: str, link_names: list[str]) -> tuple[str, str]:
    """Pick the surviving folder name. Returns ``(name, why)``.

    The terminal wins when it says something. Otherwise the search walks up the
    chain, nearest first, for a name worth inheriting. Stopping at the first
    folder up would discard names like ``landscape and Becs`` sitting one step
    further along, so the walk continues; it just refuses to settle for a
    fragment. When the whole chain is buckets and fragments, the fallback
    applies.
    """
    if not is_bucket(terminal_name):
        return terminal_name, "terminal name kept"

    for depth, name in enumerate(reversed(link_names), start=1):
        if is_bucket(name) or len(name) < MIN_INHERITABLE_LENGTH:
            continue
        step = "the folder above" if depth == 1 else f"{depth} folders above"
        return name, f"{terminal_name!r} is a bucket, took {step}"

    return FALLBACK_NAME, f"{terminal_name!r} and every folder above it are buckets"
