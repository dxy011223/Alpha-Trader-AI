import asyncio
import base64
import hashlib
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
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

    owner = asyncio.run(require_owner(_request("http", "127.0.0.1"), None))

    assert len(owner) == 24


def test_owner_still_requires_token_outside_local_development(monkeypatch):
    monkeypatch.setattr(
        "app.security.get_settings",
        lambda: SimpleNamespace(owner_api_token=None, environment="production"),
    )

    with pytest.raises(HTTPException) as error:
        asyncio.run(require_owner(_request("https", "203.0.113.10"), None))

    assert error.value.status_code == 503


def test_owner_accepts_a_fresh_worker_signature(monkeypatch):
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    monkeypatch.setattr("app.security._WORKER_SIGNING_PUBLIC_KEY", public_key)
    monkeypatch.setattr(
        "app.security.get_settings",
        lambda: SimpleNamespace(owner_api_token="different-owner-token", environment="production"),
    )
    timestamp = str(int(time.time()))
    body = b'{"symbol":"BTC"}'
    path = "/api/v1/ai/analyze"
    message = f"{timestamp}\nPOST\n{path}\n{hashlib.sha256(body).hexdigest()}".encode()
    der_signature = private_key.sign(message, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_signature)
    raw_signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    signature = base64.urlsafe_b64encode(raw_signature).rstrip(b"=")
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({
        "type": "http",
        "method": "POST",
        "path": path,
        "query_string": b"",
        "headers": [
            (b"x-alpha-worker-timestamp", timestamp.encode()),
            (b"x-alpha-worker-signature", signature),
        ],
        "scheme": "https",
        "server": ("api.example.test", 443),
        "client": ("203.0.113.10", 12345),
    }, receive)

    owner = asyncio.run(require_owner(request, None))

    assert len(owner) == 24
