import asyncio

from app import services
from app.schemas import AnalysisRequest, Candle, MarketSnapshot


def test_user_fills_by_time_paginates_and_deduplicates(monkeypatch):
    pages = [
        [
            {"tid": 1, "time": 1000, "coin": "BTC", "px": "100", "sz": "1", "side": "B"},
            {"tid": 2, "time": 2000, "coin": "BTC", "px": "110", "sz": "1", "side": "A"},
        ],
        [
            {"tid": 2, "time": 2000, "coin": "BTC", "px": "110", "sz": "1", "side": "A"},
            {"tid": 3, "time": 3000, "coin": "ETH", "px": "200", "sz": "2", "side": "B"},
        ],
        [],
    ]
    requests: list[dict] = []

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, json):
            requests.append(json)
            return Response(pages.pop(0))

    monkeypatch.setattr(services.time, "time", lambda: 10)
    monkeypatch.setattr(services.httpx, "AsyncClient", lambda **_kwargs: Client())

    fills = asyncio.run(services.get_user_fills_by_time("0x" + "1" * 40, 500))

    assert [fill["tid"] for fill in fills] == [1, 2, 3]
    assert [request["startTime"] for request in requests] == [500, 2001, 3001]
    assert all(request["endTime"] == 10_000 for request in requests)


def test_binance_market_snapshot_uses_real_public_fields(monkeypatch):
    payloads = [
        {"lastPrice": "100", "priceChangePercent": "2.5", "quoteVolume": "500000"},
        {"lastFundingRate": "0.0001"},
        {"openInterest": "250"},
    ]

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return payloads.pop(0)

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, params):
            assert params["symbol"] == "BTCUSDT"
            return Response()

    monkeypatch.setattr(services.httpx, "AsyncClient", lambda **_kwargs: Client())

    market = asyncio.run(services.get_live_market("BTC", "binance"))

    assert market is not None
    assert market.price == 100
    assert market.change_24h == 2.5
    assert market.funding_rate == 0.01
    assert market.open_interest == 25_000
    assert market.source == "live"


def test_okx_candles_are_normalized_to_ascending_order(monkeypatch):
    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [
                ["2000", "110", "115", "105", "112", "20", "0", "0", "1"],
                ["1000", "100", "111", "99", "110", "10", "0", "0", "1"],
            ]}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, params):
            assert params == {"instId": "BTC-USDT-SWAP", "bar": "1H", "limit": 2}
            return Response()

    monkeypatch.setattr(services.httpx, "AsyncClient", lambda **_kwargs: Client())

    candles = asyncio.run(services.get_candles("BTC", "1h", 2, "okx"))

    assert [candle.open_time for candle in candles] == [1000, 2000]
    assert candles[0].close == 110


def test_okx_market_converts_base_volume_to_quote_value(monkeypatch):
    responses = iter([
        {"data": [{"last": "100", "open24h": "98", "volCcy24h": "12500"}]},
        {"data": [{"fundingRate": "0.0001"}]},
        {"data": [{"oiCcy": "250"}]},
    ])

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, params):
            assert params["instId"] == "BTC-USDT-SWAP"
            return Response(next(responses))

    monkeypatch.setattr(services.httpx, "AsyncClient", lambda **_kwargs: Client())

    market = asyncio.run(services.get_live_market("BTC", "okx"))

    assert market is not None
    assert market.volume == 1_250_000
    assert market.open_interest == 25_000
    assert market.platform == "okx"


def test_technical_indicators_use_candle_history():
    candles = [
        Candle(
            open_time=index * 60_000,
            close_time=(index + 1) * 60_000 - 1,
            open=100 + index,
            high=101.5 + index,
            low=99.5 + index,
            close=101 + index,
            volume=1_000,
        )
        for index in range(220)
    ]

    indicators = services.calculate_technical_indicators(candles)

    assert indicators.ema20 > indicators.ema50 > indicators.ema200
    assert indicators.rsi14 == 100
    assert indicators.atr14 > 0
    assert indicators.atr_percent > 0


def test_score_below_seventy_is_observation_only():
    market = MarketSnapshot(
        symbol="TEST",
        price=100,
        change_24h=0.5,
        volume=2_000_000,
        volatility=8,
        funding_rate=0.05,
        open_interest=1_000_000,
        source="live",
    )

    decision = services.analyze_market(AnalysisRequest(symbol="TEST"), market, 10_000)

    assert decision.score < 70
    assert decision.direction == "WAIT"
    assert decision.position_sizing.margin_amount == 0
