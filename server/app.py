"""FastAPI entrypoint for the TramTrace ESP32 payload."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .errors import MissingTokenError, RealtimeFeedError, StaticGTFSLoadError
from .service import Settings, TramTraceService


def _no_store(payload: object, *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def create_app(service: TramTraceService | None = None) -> FastAPI:
    backend = service or TramTraceService(Settings.from_env())
    application = FastAPI(
        title="TramTrace",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
    )
    application.state.tramtrace = backend

    @application.get("/tramtrace_payload")
    def tramtrace_payload() -> JSONResponse:
        try:
            return _no_store(backend.payload())
        except MissingTokenError:
            return _no_store(
                {"error": "missing_tfnsw_api_token"},
                status_code=503,
            )
        except StaticGTFSLoadError:
            return _no_store(
                {"error": "static_gtfs_unavailable"},
                status_code=503,
            )
        except RealtimeFeedError:
            return _no_store(
                {"error": "realtime_feed_unavailable"},
                status_code=503,
            )

    @application.get("/healthz")
    def healthz() -> JSONResponse:
        payload, healthy = backend.health()
        return _no_store(payload, status_code=200 if healthy else 503)

    return application


app = create_app()
