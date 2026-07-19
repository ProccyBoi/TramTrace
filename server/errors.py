"""Backend-specific exceptions that can be translated into API responses."""


class TramTraceError(RuntimeError):
    """Base class for expected service failures."""


class MissingTokenError(TramTraceError):
    """Raised when a TfNSW network call is attempted without a token."""


class StaticGTFSLoadError(TramTraceError):
    """Raised when the configured static GTFS source is unusable."""


class RealtimeFeedError(TramTraceError):
    """Raised when no configured GTFS-Realtime feed can be fetched."""
