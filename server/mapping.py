"""Canonical PCB station labels and TfNSW name normalisation."""

from __future__ import annotations

import re
import unicodedata
from types import MappingProxyType
from typing import Final


# These are the physical orders printed on the TramTrace PCB.  Direction slots
# follow current TfNSW trip headsigns; L4 happens to run opposite to its PCB
# chain order, so terminus mapping is kept explicitly below.
PCB_ROUTE_ORDERS: Final[MappingProxyType[str, tuple[str, ...]]] = MappingProxyType(
    {
        "L1": (
            "Dulwich Hill",
            "Dulwich Grove",
            "Arlington",
            "Waratah Mills",
            "Lewisham West",
            "Taverners Hill",
            "Marion",
            "Hawthorne",
            "Leichhardt North",
            "Lilyfield",
            "Rozelle Bay",
            "Jubilee Park",
            "Glebe",
            "Wentworth Park",
            "Bank Street",
            "John Street Square",
            "The Star",
            "Pyrmont Bay",
            "Convention",
            "Exhibition Centre",
            "Paddy's Markets",
            "Capitol Square",
            "Central",
        ),
        "L2": (
            "Randwick",
            "UNSW High Street",
            "Wansey Road",
            "Royal Randwick",
            "Moore Park",
            "Surry Hills",
            "Central",
            "Haymarket",
            "Chinatown",
            "Town Hall",
            "QVB",
            "Wynyard",
            "Bridge Street",
            "Circular Quay",
        ),
        "L3": (
            "Juniors Kingsford",
            "Kingsford",
            "UNSW Anzac Parade",
            "Kensington",
            "ES Marks",
            "Moore Park",
            "Surry Hills",
            "Central",
            "Haymarket",
            "Chinatown",
            "Town Hall",
            "QVB",
            "Wynyard",
            "Bridge Street",
            "Circular Quay",
        ),
        "L4": (
            "Carlingford",
            "Telopea",
            "Dundas",
            "Yallamundi",
            "Rosehill Gardens",
            "Tramway Avenue",
            "Robin Thomas",
            "Parramatta Square",
            "Church Street",
            "Prince Alfred Square",
            "Fennell Street",
            "Benaud Oval",
            "Ngara",
            "Childrens Hospital",
            "Westmead Hospital",
            "Westmead",
        ),
    }
)

ROUTE_TERMINI: Final[MappingProxyType[str, tuple[str, str]]] = MappingProxyType(
    {
        "L1": ("Dulwich Hill", "Central"),
        "L2": ("Randwick", "Circular Quay"),
        "L3": ("Juniors Kingsford", "Circular Quay"),
        "L4": ("Westmead", "Carlingford"),
    }
)

SUPPORTED_ROUTES: Final[frozenset[str]] = frozenset(PCB_ROUTE_ORDERS)

_SPACE_RE = re.compile(r"\s+")
_PLATFORM_RE = re.compile(r"\bplatform\s*[a-z0-9-]*\b", re.IGNORECASE)
_SUFFIX_RE = re.compile(
    r"(?:\s+(?:light\s+rail(?:\s+station)?|station|stop))+$",
    re.IGNORECASE,
)


def normalise_station_name(value: str | None) -> str:
    """Return a punctuation-insensitive key for a stop or headsign."""

    if not value:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = text.replace("\u2018", "'").replace("\u2019", "'").replace("&", " and ")
    text = _PLATFORM_RE.sub(" ", text)
    text = _SUFFIX_RE.sub("", text.strip())
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return _SPACE_RE.sub(" ", text).strip()


def _route_aliases() -> dict[str, dict[str, str]]:
    by_route: dict[str, dict[str, str]] = {}
    for route, stations in PCB_ROUTE_ORDERS.items():
        aliases = {normalise_station_name(station): station for station in stations}
        by_route[route] = aliases

    common = {
        "queen victoria building": "QVB",
        "q v b": "QVB",
        "e s marks": "ES Marks",
        "e s marks athletics field": "ES Marks",
        "es marks athletics field": "ES Marks",
        "children s hospital": "Childrens Hospital",
        "children hospital": "Childrens Hospital",
        "the children s hospital": "Childrens Hospital",
        "fish market": "Bank Street",
        "bank st": "Bank Street",
        "convention centre": "Convention",
        "paddys markets": "Paddy's Markets",
        "junior s kingsford": "Juniors Kingsford",
    }
    for aliases in by_route.values():
        for key, station in common.items():
            if station in aliases.values():
                aliases[key] = station

    # TfNSW uses distinct Central names for the L1 concourse and L2/L3
    # Chalmers Street platforms.  The PCB deliberately prints all as Central.
    for key in (
        "central station",
        "central grand concourse",
        "central railway station",
        "central",
    ):
        by_route["L1"][key] = "Central"
    for route in ("L2", "L3"):
        for key in (
            "central chalmers street",
            "central chalmers st",
            "central station chalmers street",
            "central station",
            "central",
        ):
            by_route[route][key] = "Central"

    return by_route


_ALIASES: Final[dict[str, dict[str, str]]] = _route_aliases()


def canonical_station(route: str, value: str | None) -> str | None:
    """Map an official/legacy TfNSW name to the exact PCB label for *route*."""

    route = str(route or "").upper()
    aliases = _ALIASES.get(route)
    if aliases is None:
        return None
    key = normalise_station_name(value)
    if not key:
        return None

    direct = aliases.get(key)
    if direct:
        return direct

    # Some complete-GTFS exports append operational qualifiers after the public
    # name.  Only strip known suffixes so unrelated stops cannot collide.
    for suffix in (" light rail", " light rail station", " station", " stop"):
        if key.endswith(suffix):
            direct = aliases.get(key[: -len(suffix)].strip())
            if direct:
                return direct
    return None


def route_station_index(route: str, station: str) -> int | None:
    """Return a station's physical index, or ``None`` if it is not on the PCB."""

    try:
        return PCB_ROUTE_ORDERS[route].index(station)
    except (KeyError, ValueError):
        return None


def empty_states() -> dict[str, dict[str, list[int]]]:
    """Create an independent, insertion-ordered all-off payload state map."""

    return {
        route: {station: [0, 0] for station in stations}
        for route, stations in PCB_ROUTE_ORDERS.items()
    }
