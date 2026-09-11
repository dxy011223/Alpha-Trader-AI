import asyncio

import pytest

from app import exchange_accounts
from app.platform_credentials import PlatformCredentialValues


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class FakeClient:
    def __init__(self, responses, calls):
        self.responses = responses
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        for path, payload in self.responses:
            if path in url:
                return FakeResponse(payload)
        raise AssertionError(f"未配置测试响应：{url}")


def test_binance_account_is_normalized(monkeypatch):
    calls = []
    responses = [
        ("/fapi/v3/account", {
            "totalMarginBalance": "120.5",
            "availableBalance": "80.1",
            "totalUnrealizedProfit": "2.4",
            "positions": [{
                "symbol": "BTCUSDT",
                "positionAmt": "0.01",
                "entryPrice": "70000",
                "notional": "710",
                "unrealizedProfit": "10",
                "leverage": "3",
            }],
        }),
        ("/fapi/v1/userTrades", [{
            "price": "71000",
            "qty": "0.01",
            "buyer": False,
            "time": 1_000,
            "commission": "0.2",
            "realizedPnl": "10",
            "id": 7,
        }]),
    ]
    monkeypatch.setattr(
        exchange_accounts.httpx,
        "AsyncClient",
        lambda **_kwargs: FakeClient(responses, calls),
    )

    snapshot = asyncio.run(exchange_accounts.get_exchange_account(
        "binance", PlatformCredentialValues("api-key-1234", "secret-key", None), "BTC"
    ))

    assert snapshot.source == "live"
    assert snapshot.platform == "binance"
    assert snapshot.address == "binance:api-…1234"
    assert snapshot.positions[0]["coin"] == "BTC"
    assert snapshot.history[0]["side"] == "A"
    assert calls[0][1]["headers"] == {"X-MBX-APIKEY": "api-key-1234"}
    assert "signature" in calls[0][1]["params"]


def test_okx_account_is_normalized(monkeypatch):
    calls = []
    responses = [
        ("/api/v5/account/balance", {"code": "0", "data": [{
            "totalEq": "220",
            "details": [{"availEq": "150"}],
        }]}),
        ("/api/v5/account/positions", {"code": "0", "data": [{
            "instId": "ETH-USDT-SWAP",
            "pos": "2",
            "posSide": "short",
            "avgPx": "3000",
            "notionalUsd": "6000",
            "upl": "-12",
            "lever": "2",
            "mgnMode": "cross",
        }]}),
        ("/api/v5/public/instruments", {"code": "0", "data": [{
            "instId": "ETH-USDT-SWAP",
            "ctVal": "0.01",
        }]}),
        ("/api/v5/trade/fills-history", {"code": "0", "data": [{
            "fillPx": "2980",
            "fillSz": "2",
            "side": "buy",
            "fillTime": "2000",
            "fee": "-0.3",
            "fillPnl": "40",
            "tradeId": "9",
        }]}),
    ]
    monkeypatch.setattr(
        exchange_accounts.httpx,
        "AsyncClient",
        lambda **_kwargs: FakeClient(responses, calls),
    )

    snapshot = asyncio.run(exchange_accounts.get_exchange_account(
        "okx", PlatformCredentialValues("okx-key-1234", "secret-key", "passphrase"), "ETH"
    ))

    assert snapshot.source == "live"
    assert snapshot.platform == "okx"
    assert snapshot.positions[0]["szi"] == "-0.02"
    assert snapshot.history[0]["sz"] == "0.02"
    assert snapshot.history[0]["fee"] == "0.3"
    assert calls[0][1]["headers"]["OK-ACCESS-PASSPHRASE"] == "passphrase"
    assert "OK-ACCESS-SIGN" in calls[0][1]["headers"]


class EmptyContextClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


def test_binance_rejects_truncated_fill_history(monkeypatch):
    async def fake_binance_get(_client, _path, _credentials, params):
        start = int(params.get("fromId", 0))
        return [{"id": start + index, "time": 2_000} for index in range(1_000)]

    monkeypatch.setattr(exchange_accounts.httpx, "AsyncClient", lambda **_kwargs: EmptyContextClient())
    monkeypatch.setattr(exchange_accounts, "_binance_get", fake_binance_get)

    with pytest.raises(exchange_accounts.FillHistoryIncompleteError, match="安全读取上限"):
        asyncio.run(exchange_accounts.get_exchange_fills(
            "binance", PlatformCredentialValues("key", "secret", None), "BTC", 1_000
        ))


def test_okx_rejects_truncated_fill_history(monkeypatch):
    async def fake_okx_get(_client, path, _credentials, params):
        if path.endswith("/instruments"):
            return [{"instId": "BTC-USDT-SWAP", "ctVal": "0.01"}]
        page = int(params.get("after", "0") or 0)
        return [
            {"billId": str(page + index + 1), "tradeId": str(page + index + 1), "fillTime": "2000"}
            for index in range(100)
        ]

    monkeypatch.setattr(exchange_accounts.httpx, "AsyncClient", lambda **_kwargs: EmptyContextClient())
    monkeypatch.setattr(exchange_accounts, "_okx_get", fake_okx_get)

    with pytest.raises(exchange_accounts.FillHistoryIncompleteError, match="安全读取上限"):
        asyncio.run(exchange_accounts.get_exchange_fills(
            "okx", PlatformCredentialValues("key", "secret", "passphrase"), "BTC", 1_000
        ))
