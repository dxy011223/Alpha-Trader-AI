import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app import services
from app.schemas import (
    AnalysisRequest,
    Candle,
    DecisionHistoryPolicy,
    HistoryDirectionPerformance,
    MarketSnapshot,
    NewsItem,
    TechnicalIndicators,
)


def _aligned_indicators(direction: str = "LONG", **updates) -> TechnicalIndicators:
    values = {
        "ema20": 110 if direction == "LONG" else 90,
        "ema50": 98 if direction == "LONG" else 102,
        "ema200": 90 if direction == "LONG" else 110,
    }
    values.update(updates)
    return TechnicalIndicators(**values)


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


def test_candles_retry_after_rate_limit(monkeypatch):
    attempts = 0
    delays: list[float] = []

    class Response:
        headers = {"retry-after": "0.01"}

        def __init__(self, status_code: int):
            self.status_code = status_code

        def raise_for_status(self):
            if self.status_code >= 400:
                raise services.httpx.HTTPStatusError(
                    "请求失败", request=services.httpx.Request("POST", "https://example.test"), response=self
                )

        def json(self):
            return [{"t": 1000, "T": 1999, "o": "100", "h": "110", "l": "90", "c": "105", "v": "10"}]

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, json):
            nonlocal attempts
            attempts += 1
            return Response(429 if attempts == 1 else 200)

    async def fake_sleep(delay: float):
        delays.append(delay)

    monkeypatch.setattr(services.httpx, "AsyncClient", lambda **_kwargs: Client())
    monkeypatch.setattr(services.asyncio, "sleep", fake_sleep)

    candles = asyncio.run(services.get_candles("BTC", "4h", 220))

    assert attempts == 2
    assert delays == [0.01]
    assert candles[0].close == 105


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


def test_technical_indicators_use_only_completed_candle_history():
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
    candles.append(Candle(
        open_time=int(services.time.time() * 1000),
        close_time=int(services.time.time() * 1000) + 60_000,
        open=10_000,
        high=10_001,
        low=1,
        close=10_000,
        volume=1,
    ))

    indicators = services.calculate_technical_indicators(candles)

    assert indicators.ema20 > indicators.ema50 > indicators.ema200
    assert indicators.ema20_slope_percent > 0
    assert indicators.ema50_slope_percent > 0
    assert indicators.rsi14 == 100
    assert indicators.atr14 > 0
    assert indicators.atr_percent > 0
    assert indicators.volume_ratio == 1


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


def test_moving_average_direction_is_a_hard_execution_gate():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )

    long_decision = services.analyze_market(
        AnalysisRequest(symbol="TEST"), market, indicators=_aligned_indicators("LONG")
    )
    short_decision = services.analyze_market(
        AnalysisRequest(symbol="TEST"),
        market.model_copy(update={"change_24h": -4}),
        indicators=_aligned_indicators("SHORT"),
    )
    mixed_decision = services.analyze_market(
        AnalysisRequest(symbol="TEST"),
        market,
        indicators=TechnicalIndicators(ema20=101, ema50=99, ema200=100),
    )
    missing_decision = services.analyze_market(AnalysisRequest(symbol="TEST"), market)

    assert long_decision.direction == "LONG"
    assert short_decision.direction == "SHORT"
    for decision in (mixed_decision, missing_decision):
        assert decision.direction == "WAIT"
        assert decision.position_sizing.margin_amount == 0
        assert "均线方向" in decision.status_reason
        assert "不生成可执行决策" in decision.status_reason


def test_technical_confluence_rejects_weak_conflicted_or_overextended_entries():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    scenarios = [
        TechnicalIndicators(ema20=100.08, ema50=100.04, ema200=100),
        _aligned_indicators(rsi14=45, macd_histogram=-0.5),
        _aligned_indicators(rsi14=75),
        _aligned_indicators(ema20_slope_percent=-0.1, ema50_slope_percent=0.1),
        _aligned_indicators(volume_ratio=0.4),
    ]
    decisions = [
        services.analyze_market(AnalysisRequest(symbol="TEST"), market, indicators=indicators)
        for indicators in scenarios
    ]
    decisions.extend([
        services.analyze_market(
            AnalysisRequest(symbol="TEST"),
            market.model_copy(update={"price": 95}),
            indicators=_aligned_indicators(),
        ),
        services.analyze_market(
            AnalysisRequest(symbol="TEST"),
            market.model_copy(update={"price": 105}),
            indicators=TechnicalIndicators(
                ema20=101, ema50=100, ema200=99, atr14=1, atr_percent=0.95,
            ),
        ),
        services.analyze_market(
            AnalysisRequest(symbol="TEST"),
            market.model_copy(update={"funding_rate": 0.06}),
            indicators=_aligned_indicators(),
        ),
    ])

    assert all(decision.direction == "WAIT" for decision in decisions)
    assert all(decision.position_sizing.margin_amount == 0 for decision in decisions)
    assert all("技术准入未通过" in decision.status_reason for decision in decisions)
    assert any("均线总间距" in decision.status_reason for decision in decisions)
    assert any("价格结构未确认" in decision.status_reason for decision in decisions)
    assert any("短期动量" in decision.status_reason for decision in decisions)
    assert any("过热区" in decision.status_reason for decision in decisions)
    assert any("斜率" in decision.status_reason for decision in decisions)
    assert any("量能不足" in decision.status_reason for decision in decisions)
    assert any("过度拥挤" in decision.status_reason for decision in decisions)
    assert any("不宜追价" in decision.status_reason for decision in decisions)


def test_relevant_news_changes_rule_score_in_expected_direction():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    bullish = NewsItem(
        id=1, title="利多事件", source="测试源", published_at="2026-09-13 08:00",
        impact=5, assets=["TEST"], direction="bullish", analysis="测试",
    )
    bearish = bullish.model_copy(update={"id": 2, "title": "利空事件", "direction": "bearish"})

    supported = services.analyze_market(
        AnalysisRequest(symbol="TEST"), market, 10_000,
        indicators=_aligned_indicators(), news_items=[bullish]
    )
    opposed = services.analyze_market(
        AnalysisRequest(symbol="TEST"), market, 10_000,
        indicators=_aligned_indicators(), news_items=[bearish]
    )

    assert supported.score_breakdown.news == 10
    assert opposed.score_breakdown.news == 4
    assert supported.score > opposed.score
    assert any("参考 1 条相关事件" in reason for reason in supported.reasons)


def test_atr_execution_levels_use_pullback_entries_and_fixed_reward_risk():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    indicators = _aligned_indicators(atr14=2, atr_percent=2)

    long_entry, long_stop, long_targets = services.build_execution_levels(
        market, "LONG", "low", indicators
    )
    short_entry, short_stop, short_targets = services.build_execution_levels(
        market, "SHORT", "low", _aligned_indicators("SHORT", atr14=2, atr_percent=2)
    )
    wait_entry, wait_stop, wait_targets = services.build_execution_levels(
        market, "WAIT", "low", indicators
    )

    long_optimal = services.calculate_optimal_entry_price(market, "LONG", long_entry, indicators)
    short_indicators = _aligned_indicators("SHORT", atr14=2, atr_percent=2)
    short_optimal = services.calculate_optimal_entry_price(market, "SHORT", short_entry, short_indicators)
    assert long_entry == [98.5, 99.5]
    assert long_optimal == 99.5
    assert long_stop < long_entry[0] < long_entry[1] < long_targets[0] < long_targets[1]
    assert (long_targets[0] - long_optimal) / (long_optimal - long_stop) == pytest.approx(2)
    assert (long_targets[1] - long_optimal) / (long_optimal - long_stop) == pytest.approx(3)
    assert short_entry == [100.5, 101.5]
    assert short_optimal == 100.5
    assert short_targets[1] < short_targets[0] < short_entry[0] < short_entry[1] < short_stop
    assert (short_optimal - short_targets[0]) / (short_stop - short_optimal) == pytest.approx(2)
    assert (short_optimal - short_targets[1]) / (short_stop - short_optimal) == pytest.approx(3)
    assert wait_entry == wait_targets == [100, 100]
    assert wait_stop == 100


def test_execution_levels_keep_percentage_fallback_without_atr():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )

    entry, stop, targets = services.build_execution_levels(market, "LONG", "low")

    assert entry == [99.2, 99.7]
    optimal = services.calculate_optimal_entry_price(market, "LONG", entry)
    assert optimal == 99.45
    assert stop == 97.461
    assert targets == [103.428, 105.417]


def test_decision_plan_keeps_original_levels_and_only_executes_inside_entry_range():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    original_market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), original_market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    refreshed_market = original_market.model_copy(update={"price": 99.5, "change_24h": 2.2})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), refreshed_market, 10_000,
        _aligned_indicators(),
    )

    baseline = services.refresh_decision_plan(
        original, refreshed, refreshed_market.price, "4h", 10_000,
        generated_at + timedelta(minutes=30),
    )
    decision = services.refresh_decision_plan(
        original, refreshed, refreshed_market.price, "4h", 20_000,
        generated_at + timedelta(minutes=30),
    )

    assert decision.entry_range == original.entry_range
    assert decision.stop_loss == original.stop_loss
    assert decision.take_profit == original.take_profit
    assert decision.current_price == 99.5
    assert decision.decision_status == "executable"
    assert decision.is_executable is True
    assert decision.position_sizing.margin_amount == pytest.approx(
        baseline.position_sizing.margin_amount * 2, rel=1e-5
    )
    assert decision.position_sizing.position_value == pytest.approx(
        baseline.position_sizing.position_value * 2, rel=1e-5
    )


def test_decision_plan_marks_original_target_as_reached_instead_of_chasing_price():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    refreshed_market = market.model_copy(update={"price": original.take_profit[0], "change_24h": 4})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), refreshed_market, 10_000,
        _aligned_indicators(),
    )

    decision = services.refresh_decision_plan(
        original, refreshed, refreshed_market.price, "4h", 10_000,
        generated_at + timedelta(hours=1),
    )

    assert decision.entry_range == original.entry_range
    assert decision.decision_status == "target_reached"
    assert decision.is_executable is False
    assert "禁止追价" in decision.status_reason


def test_decision_plan_invalidates_when_latest_signal_no_longer_meets_threshold():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    weak_market = market.model_copy(update={"price": 99.5, "change_24h": 0, "volatility": 8, "funding_rate": 0.05})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), weak_market, 10_000
    )

    first_review = services.refresh_decision_plan(
        original, refreshed, weak_market.price, "4h", 10_000,
        generated_at + timedelta(minutes=30),
    )
    decision = services.refresh_decision_plan(
        first_review, refreshed, weak_market.price, "4h", 10_000,
        generated_at + timedelta(minutes=31),
    )

    assert first_review.decision_status == "confirming"
    assert first_review.soft_failure_count == 1
    assert decision.decision_status == "invalidated"
    assert decision.is_executable is False
    assert "连续两次" in decision.status_reason


def test_missed_entry_creates_a_versioned_reprice_after_two_reviews():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    refreshed_market = market.model_copy(update={"price": 100.2, "change_24h": 2.2})
    indicators = _aligned_indicators(atr14=1.5, atr_percent=1.5)
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), refreshed_market, 10_000, indicators
    ).model_copy(update={
        "direction": original.direction,
        "score": max(original.score, 75),
        "confidence": max(original.confidence, 75),
    })

    first_review = services.refresh_decision_plan(
        original, refreshed, refreshed_market.price, "4h", 10_000,
        generated_at + timedelta(minutes=1),
    )
    revised = services.refresh_decision_plan(
        first_review, refreshed, refreshed_market.price, "4h", 10_000,
        generated_at + timedelta(minutes=2),
    )

    assert first_review.decision_status == "missed_entry"
    assert first_review.missed_entry_count == 1
    assert revised.plan_id == original.plan_id
    assert revised.decision_revision == 2
    assert revised.entry_range == refreshed.entry_range
    assert revised.entry_range != original.entry_range
    assert revised.stop_loss == refreshed.stop_loss
    assert revised.take_profit == refreshed.take_profit
    assert revised.revision_history[0].entry_range == original.entry_range
    assert revised.revision_history[0].archive_reason == "missed_entry"
    assert "重新报价" in revised.revision_reason


def test_missed_entry_does_not_create_more_than_two_reprices():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={
        "generated_at": generated_at.isoformat(),
        "decision_revision": 3,
        "missed_entry_count": 1,
    })
    refreshed_market = market.model_copy(update={"price": 100.2, "change_24h": 2.2})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"),
        refreshed_market,
        10_000,
        _aligned_indicators(atr14=1.5, atr_percent=1.5),
    ).model_copy(update={
        "direction": original.direction,
        "score": max(original.score, 75),
        "confidence": max(original.confidence, 75),
    })

    decision = services.refresh_decision_plan(
        original, refreshed, refreshed_market.price, "4h", 10_000,
        generated_at + timedelta(minutes=1),
    )

    assert decision.decision_revision == 3
    assert decision.decision_status == "missed_entry"
    assert "最多两次" in decision.status_reason


def test_post_decision_candle_uses_stop_first_when_target_and_stop_both_touched():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000,
        _aligned_indicators(),
    )
    candle = Candle(
        open_time=int(generated_at.timestamp() * 1000) + 1,
        close_time=int(generated_at.timestamp() * 1000) + 60_000,
        open=100,
        high=max(original.take_profit[0], original.stop_loss) + 1,
        low=min(original.take_profit[0], original.stop_loss) - 1,
        close=100,
        volume=1000,
    )

    decision = services.refresh_decision_plan(
        original, refreshed, 100, "4h", 10_000,
        generated_at + timedelta(minutes=1),
        candles=[candle],
    )

    assert decision.decision_status == "invalidated"
    assert "止损" in decision.status_reason


def test_expired_decision_plan_allows_a_new_plan():
    generated_at = datetime(2026, 9, 13, 8, tzinfo=UTC)
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=2, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="1h"), market, 10_000,
        _aligned_indicators(),
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    refreshed_market = market.model_copy(update={"price": 110})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="1h"), refreshed_market, 10_000,
        _aligned_indicators(),
    )

    decision = services.refresh_decision_plan(
        original, refreshed, refreshed_market.price, "1h", 10_000,
        generated_at + timedelta(hours=1, seconds=1),
    )

    assert decision.entry_range == refreshed.entry_range
    assert decision.reference_price == 110


def test_history_policy_changes_decision_threshold_without_rewriting_score():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=1, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    policy = DecisionHistoryPolicy(
        sample_count=20,
        wins=14,
        losses=6,
        win_rate=70,
        average_r=0.8,
        recent_win_rate=66.67,
        threshold_adjustment=-2,
        risk_multiplier=1.05,
        direction_performance={
            "LONG": HistoryDirectionPerformance(
                sample_count=10,
                wins=8,
                win_rate=80,
                threshold_adjustment=-1,
                risk_multiplier=1.05,
            )
        },
        fingerprint="history-v1",
        scope_key="owner-v1",
    )

    baseline = services.analyze_market(
        AnalysisRequest(symbol="TEST"), market, indicators=_aligned_indicators(),
        strategy_parameters={"min_trade_score": 80},
    )
    optimized = services.analyze_market(
        AnalysisRequest(symbol="TEST"),
        market,
        indicators=_aligned_indicators(),
        strategy_parameters={"min_trade_score": 80},
        history_policy=policy,
    )

    assert baseline.score == optimized.score == 78
    assert baseline.direction == "WAIT"
    assert optimized.direction == "LONG"
    assert optimized.history_policy is not None
    assert optimized.history_policy.applied_threshold == 77
    assert optimized.history_policy.applied_risk_multiplier == 1.05


def test_history_policy_threshold_is_reused_during_execution_review():
    generated_at = datetime(2026, 9, 14, 8, tzinfo=UTC)
    policy = DecisionHistoryPolicy(
        sample_count=20,
        wins=14,
        losses=6,
        win_rate=70,
        average_r=0.8,
        recent_win_rate=66.67,
        threshold_adjustment=-2,
        risk_multiplier=1.05,
        fingerprint="history-v1",
        scope_key="owner-v1",
    )
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=1, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    original = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"), market,
        indicators=_aligned_indicators(),
        strategy_parameters={"min_trade_score": 80}, history_policy=policy
    ).model_copy(update={"generated_at": generated_at.isoformat()})
    refreshed_market = market.model_copy(update={"price": 99.5, "change_24h": 2.5})
    refreshed = services.analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"),
        refreshed_market,
        indicators=_aligned_indicators(),
        strategy_parameters={"min_trade_score": 80},
        history_policy=policy,
    )

    reviewed = services.refresh_decision_plan(
        original,
        refreshed,
        refreshed_market.price,
        "4h",
        10_000,
        generated_at + timedelta(minutes=1),
    )

    assert refreshed.score == 80
    assert reviewed.decision_status == "executable"
    assert reviewed.is_executable is True


def test_history_policy_reduces_risk_budget_after_weak_results():
    market = MarketSnapshot(
        symbol="TEST", price=100, change_24h=4, volume=2_000_000,
        volatility=2, funding_rate=0, open_interest=1_000_000, source="live",
    )
    policy = DecisionHistoryPolicy(
        sample_count=20,
        wins=7,
        losses=13,
        win_rate=35,
        average_r=-0.2,
        recent_win_rate=16.67,
        consecutive_losses=3,
        threshold_adjustment=3,
        risk_multiplier=0.65,
        fingerprint="weak-history",
        scope_key="owner-v1",
    )

    baseline = services.analyze_market(
        AnalysisRequest(symbol="TEST"), market, indicators=_aligned_indicators()
    )
    optimized = services.analyze_market(
        AnalysisRequest(symbol="TEST"), market,
        indicators=_aligned_indicators(), history_policy=policy
    )

    assert optimized.score == baseline.score
    assert optimized.direction == baseline.direction == "LONG"
    assert optimized.history_policy is not None
    assert optimized.history_policy.applied_threshold == 73
    assert optimized.position_sizing.risk_budget_amount < baseline.position_sizing.risk_budget_amount


def test_history_policy_ignores_insufficient_or_invalid_aggregates():
    insufficient = DecisionHistoryPolicy(
        sample_count=11,
        wins=11,
        win_rate=100,
        average_r=2,
        recent_win_rate=100,
        threshold_adjustment=-2,
        risk_multiplier=1.05,
        fingerprint="small-sample",
    )

    assert services.apply_history_policy(70, "LONG", insufficient) == (70, 1, None)
    assert services.parse_history_policy(
        '{"platforms":{"hyperliquid":{"sample_count":12,"wins":13,"losses":0,'
        '"win_rate":100,"average_r":1,"recent_win_rate":100,'
        '"threshold_adjustment":-2,"risk_multiplier":1.05,'
        '"direction_performance":{},"fingerprint":"invalid"}}}',
        "hyperliquid",
    ) is None
    assert services.parse_history_policy(
        '{"platforms":{"binance":{"sample_count":12,"wins":8,"losses":4,'
        '"win_rate":66.67,"average_r":0.5,"recent_win_rate":66.67,'
        '"threshold_adjustment":-1,"risk_multiplier":1,'
        '"direction_performance":{},"fingerprint":"binance-v1"}}}',
        "hyperliquid",
    ) is None
