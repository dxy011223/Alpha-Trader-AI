from fastapi.testclient import TestClient

from app.main import app
from app.schemas import MarketSnapshot
from app.services import calculate_position_sizing


client = TestClient(app)


def test_market_snapshot():
    response = client.get("/api/v1/market/BTC")
    assert response.status_code == 200
    assert response.json()["symbol"] == "BTC"


def test_unsupported_market(monkeypatch):
    async def fake_get_live_market(_symbol: str):
        return None

    monkeypatch.setattr("app.api.get_live_market", fake_get_live_market)
    response = client.get("/api/v1/market/NOTAMARKET")
    assert response.status_code == 404


def test_mobile_candle_periods(monkeypatch):
    async def fake_get_candles(symbol: str, interval: str, limit: int):
        assert (symbol, interval, limit) == ("BTC", "1m", 80)
        return []

    monkeypatch.setattr("app.api.get_candles", fake_get_candles)
    response = client.get("/api/v1/market/BTC/candles?interval=1m&limit=80")
    assert response.status_code == 200
    assert response.json() == []


def test_rejects_unknown_candle_period():
    response = client.get("/api/v1/market/BTC/candles?interval=2m")
    assert response.status_code == 422


def test_ai_analysis_has_risk_controls():
    response = client.post("/api/v1/ai/analyze", json={"symbol": "BTC", "timeframe": "4h"})
    payload = response.json()
    assert response.status_code == 200
    assert payload["direction"] in {"LONG", "SHORT", "WAIT"}
    assert payload["stop_loss"] > 0
    assert len(payload["take_profit"]) == 2
    assert payload["score"] == sum(payload["score_breakdown"].values())
    assert payload["score_breakdown"].keys() == {"trend", "structure", "capital", "macro", "news"}
    assert payload["source"] in {"live", "demo"}
    assert payload["position_sizing"]["margin_amount"] >= 0
    assert payload["position_sizing"]["position_value"] >= payload["position_sizing"]["margin_amount"]
    assert "不会自动下单" in payload["disclaimer"]


def test_position_sizing_uses_risk_and_stop_distance():
    sizing = calculate_position_sizing(
        total_amount=10_000,
        direction="LONG",
        confidence=80,
        risk="medium",
        entry_range=[100, 102],
        stop_loss=95,
        leverage=2,
    )

    assert sizing.risk_budget_rate == 0.006
    assert sizing.risk_budget_amount == 60
    assert sizing.stop_distance_rate == 0.059406
    assert sizing.margin_amount == 505
    assert sizing.position_value == 1_010
    assert sizing.max_loss_amount == 60
    assert sizing.capped is False


def test_position_sizing_caps_margin_and_blocks_wait():
    capped = calculate_position_sizing(
        total_amount=10_000,
        direction="LONG",
        confidence=100,
        risk="low",
        entry_range=[100, 100],
        stop_loss=99.9,
        leverage=2,
    )
    waiting = calculate_position_sizing(
        total_amount=10_000,
        direction="WAIT",
        confidence=90,
        risk="low",
        entry_range=[100, 100],
        stop_loss=98,
        leverage=2,
    )

    assert capped.margin_amount == 3_000
    assert capped.position_value == 6_000
    assert capped.max_loss_amount == 6
    assert capped.capped is True
    assert waiting.margin_amount == 0
    assert waiting.position_value == 0


def test_ai_opportunities_are_ranked(monkeypatch):
    markets = [
        MarketSnapshot(symbol="BTC", price=100, change_24h=0.2, volume=1_000_000, volatility=0.2, funding_rate=0.001, open_interest=2_000_000, source="live"),
        MarketSnapshot(symbol="DOGE", price=0.2, change_24h=4.0, volume=3_000_000, volatility=4.0, funding_rate=0.001, open_interest=1_000_000, source="live"),
        MarketSnapshot(symbol="ARB", price=0.4, change_24h=1.4, volume=2_000_000, volatility=1.4, funding_rate=0.001, open_interest=800_000, source="live"),
        MarketSnapshot(symbol="THIN", price=1, change_24h=20, volume=10_000, volatility=20, funding_rate=0, open_interest=5_000, source="live"),
    ]

    async def fake_get_live_markets():
        return markets

    monkeypatch.setattr("app.api.get_live_markets", fake_get_live_markets)
    response = client.get("/api/v1/ai/opportunities?timeframe=4h")
    payload = response.json()

    assert response.status_code == 200
    assert payload["scanned_markets"] == 4
    assert payload["eligible_markets"] == 3
    assert {item["symbol"] for item in payload["opportunities"]} == {"BTC", "DOGE", "ARB"}
    assert [item["score"] for item in payload["opportunities"]] == sorted(
        [item["score"] for item in payload["opportunities"]], reverse=True
    )
    top_opportunity = payload["opportunities"][0]
    assert top_opportunity["entry_range"][0] != top_opportunity["entry_range"][1]
    assert top_opportunity["stop_loss"] < top_opportunity["entry_range"][0]
