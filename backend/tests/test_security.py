import pytest
from fastapi import HTTPException, Request
from types import SimpleNamespace

from app.security import require_owner, require_secure_transport


def _request(scheme: str, client_host: str, headers: list[tuple[bytes, bytes]] | None = None) -> Request:
    return Request({
        "type": "http",
        "method": "PUT",
        "path": "/api/v1/settings/platform/binance",
        "headers": headers or [],
        "scheme": scheme,
        "server": ("api.example.test", 443 if scheme == "https" else 80),
        "client": (client_host, 12345),
    })


def test_secure_transport_rejects_spoofed_forwarded_proto():
    request = _request("http", "203.0.113.10", [(b"x-forwarded-proto", b"https")])

    with pytest.raises(HTTPException) as error:
        require_secure_transport(request)

    assert error.value.status_code == 400


def test_secure_transport_allows_https_and_loopback():
    require_secure_transport(_request("https", "203.0.113.10"))
    require_secure_transport(_request("http", "127.0.0.1"))


def test_owner_allows_unconfigured_local_development(monkeypatch):
    monkeypatch.setattr(
        "app.security.get_settings",
        lambda: SimpleNamespace(owner_api_token=None, environment="development"),
    )

    owner = require_owner(_request("http", "127.0.0.1"), None)

    assert len(owner) == 24


def test_owner_still_requires_token_outside_local_development(monkeypatch):
    monkeypatch.setattr(
        "app.security.get_settings",
        lambda: SimpleNamespace(owner_api_token=None, environment="production"),
    )

    with pytest.raises(HTTPException) as error:
        require_owner(_request("https", "203.0.113.10"), None)

    assert error.value.status_code == 503
