import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app import ai_analysis
from app.schemas import AnalysisRequest, MarketSnapshot, ReviewRecordResponse
from app.services import analyze_market
from app.strategy_scoring import DEFAULT_PARAMETERS


def test_openai_structured_output_enriches_decision(monkeypatch):
    market = MarketSnapshot(
        symbol="TEST",
        price=100,
        change_24h=-3.2,
        volume=5_000_000,
        volatility=4.1,
        funding_rate=-0.002,
        open_interest=2_000_000,
        source="live",
    )
    base = analyze_market(AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000)
    settings = SimpleNamespace(
        ai_api_key="test-key",
        ai_model="gpt-5-mini",
        ai_base_url="https://api.openai.com/v1",
        ai_timeout_seconds=20,
    )
    model_payload = {
        "decisions": [{
            "symbol": "TEST",
            "direction": "SHORT",
            "confidence": 84,
            "score": 80,
            "trend": 25,
            "structure": 21,
            "capital": 16,
            "macro": 11,
            "news": 7,
            "entry_range": [99, 100],
            "stop_loss": 103,
            "take_profit": [95, 90],
            "leverage": 3,
            "risk": "medium",
            "position_sizing": {
                "risk_budget_rate": 0.006,
                "risk_budget_amount": 60,
                "stop_distance_rate": 0.0351758794,
                "margin_amount": 568.5714286,
                "position_value": 1705.7142857,
                "max_loss_amount": 60,
                "margin_cap_rate": 0.3,
                "capped": False,
            },
            "reasons": ["价格动能偏弱。", "资金与新闻维度未出现反向确认。"],
        }]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert request.url == "https://api.openai.com/v1/responses"
        assert request.headers["Authorization"] == "Bearer test-key"
        assert body["store"] is False
        assert body["text"]["format"]["type"] == "json_schema"
        assert body["text"]["format"]["strict"] is True
        return httpx.Response(200, json={
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(model_payload)}],
            }]
        })

    original_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(ai_analysis, "get_settings", lambda: settings)
    monkeypatch.setattr(ai_analysis, "fetch_live_news", lambda: [])
    monkeypatch.setattr(
        ai_analysis.httpx,
        "AsyncClient",
        lambda **kwargs: original_async_client(transport=transport, timeout=kwargs.get("timeout")),
    )

    result = asyncio.run(ai_analysis.enrich_analyses_with_openai(
        [base], {"TEST": market}, "4h", 10_000
    ))[0]

    assert result.analysis_engine == "openai"
    assert result.analysis_model == "gpt-5-mini"
    assert result.decision_schema_version == "ai_full_v1"
    assert result.direction == "SHORT"
    assert result.score == 80
    assert result.entry_range == [99, 100]
    assert result.stop_loss == 103
    assert result.take_profit == [95, 90]
    assert result.position_sizing.margin_amount == pytest.approx(568.5714286)


def test_missing_ai_key_never_falls_back_to_rule_engine(monkeypatch):
    market = MarketSnapshot(
        symbol="TEST",
        price=100,
        change_24h=2,
        volume=5_000_000,
        volatility=2,
        funding_rate=0,
        open_interest=2_000_000,
        source="live",
    )
    base = analyze_market(AnalysisRequest(symbol="TEST", timeframe="4h"), market, 10_000)
    monkeypatch.setattr(ai_analysis, "get_settings", lambda: SimpleNamespace(ai_api_key=None))

    with pytest.raises(ai_analysis.AIDecisionUnavailable, match="未配置"):
        asyncio.run(ai_analysis.enrich_analyses_with_openai(
            [base], {"TEST": market}, "4h", 10_000
        ))


def test_openai_decision_rejects_direction_below_current_strategy_threshold():
    market = MarketSnapshot(
        symbol="TEST",
        price=100,
        change_24h=2,
        volume=5_000_000,
        volatility=2,
        funding_rate=0,
        open_interest=2_000_000,
        source="live",
    )
    base = analyze_market(
        AnalysisRequest(symbol="TEST", timeframe="4h"),
        market,
        10_000,
        strategy_version="v2",
        strategy_parameters={"min_trade_score": 80},
    )
    decision = ai_analysis.ModelDecision(
        symbol="TEST",
        direction="LONG",
        confidence=79,
        score=79,
        trend=25,
        structure=20,
        capital=15,
        macro=10,
        news=9,
        entry_range=[99, 100],
        stop_loss=95,
        take_profit=[105, 110],
        leverage=2,
        risk="medium",
        position_sizing={
            "risk_budget_rate": 0.006,
            "risk_budget_amount": 60,
            "stop_distance_rate": 0.0452261307,
            "margin_amount": 663.3333333,
            "position_value": 1326.6666667,
            "max_loss_amount": 60,
            "margin_cap_rate": 0.3,
            "capped": False,
        },
        reasons=["趋势仍然向上。", "资金指标尚未形成强确认。"],
    )

    with pytest.raises(ValueError, match="未达到"):
        ai_analysis._apply_model_decision(base, market, decision, 10_000, "test-model")


def test_openai_review_changes_text_but_not_verified_metrics(monkeypatch):
    review = ReviewRecordResponse.model_validate({
        "id": 7,
        "trade_id": 3,
        "review_type": "trade",
        "review_date": "2026-09-11",
        "result": "win",
        "summary": "已核验交易事实",
        "findings": ["真实退出价 110。", "净盈亏 9.8 USDC。"],
        "adjustments": ["等待 AI 分析。"],
        "metrics": {"exit_price": 110, "fee": 0.2, "net_pnl": 9.8},
        "created_at": "2026-09-11T00:00:00Z",
    })
    settings = SimpleNamespace(
        ai_api_key="test-key",
        ai_model="gpt-5-mini",
        ai_base_url="https://api.openai.com/v1",
        ai_timeout_seconds=20,
    )
    model_payload = {
        "summary": "该交易盈利，但仍需控制执行成本。",
        "findings": ["方向判断有效。", "手续费可继续优化。"],
        "adjustments": ["下次减少碎片化成交。"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["text"]["format"]["name"] == "trade_review"
        assert "exit_price" not in body["text"]["format"]["schema"]["properties"]
        return httpx.Response(200, json={
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(model_payload)}],
            }]
        })

    original_async_client = httpx.AsyncClient
    monkeypatch.setattr(ai_analysis, "get_settings", lambda: settings)
    monkeypatch.setattr(
        ai_analysis.httpx,
        "AsyncClient",
        lambda **kwargs: original_async_client(
            transport=httpx.MockTransport(handler), timeout=kwargs.get("timeout")
        ),
    )

    result = asyncio.run(ai_analysis.enrich_review_with_openai(
        review, {"trade": {"symbol": "TEST"}}
    ))

    assert result.summary == model_payload["summary"]
    assert result.metrics["exit_price"] == 110
    assert result.metrics["fee"] == 0.2
    assert result.metrics["net_pnl"] == 9.8
    assert result.metrics["analysis_engine"] == "openai"
    assert result.metrics["analysis_model"] == "gpt-5-mini"


def test_review_without_ai_keeps_facts_only(monkeypatch):
    review = ReviewRecordResponse.model_validate({
        "id": 9,
        "trade_id": 4,
        "review_type": "trade",
        "review_date": "2026-09-11",
        "result": "loss",
        "summary": "已核验交易事实",
        "findings": ["真实退出价 95。", "净盈亏 -5 USDC。"],
        "adjustments": ["AI 分析暂不可用，本次仅保留已核验交易事实。"],
        "metrics": {"exit_price": 95, "net_pnl": -5},
        "created_at": "2026-09-11T00:00:00Z",
    })
    monkeypatch.setattr(ai_analysis, "get_settings", lambda: SimpleNamespace(ai_api_key=None))

    result = asyncio.run(ai_analysis.enrich_review_with_openai(review, {}))

    assert result.summary == review.summary
    assert result.findings == review.findings
    assert result.adjustments == review.adjustments
    assert result.metrics["analysis_engine"] == "facts"
    assert "ai_strategy_proposal" not in result.metrics


def test_openai_daily_review_returns_strategy_proposal(monkeypatch):
    review = ReviewRecordResponse.model_validate({
        "id": 8,
        "trade_id": None,
        "review_type": "daily",
        "review_date": "2026-09-11",
        "result": "loss",
        "summary": "每日真实交易事实",
        "findings": ["完成 20 笔交易。", "净盈亏 -25 USDC。"],
        "adjustments": ["等待 AI 分析。"],
        "metrics": {"total": 20, "wins": 5, "net_pnl": -25},
        "created_at": "2026-09-11T00:00:00Z",
    })
    settings = SimpleNamespace(
        ai_api_key="test-key",
        ai_model="gpt-5-mini",
        ai_base_url="https://api.openai.com/v1",
        ai_timeout_seconds=20,
    )
    model_payload = {
        "summary": "近期方向判断偏弱，需要提高入场质量。",
        "findings": ["趋势评分在亏损样本中偏高。", "资金维度对胜单区分更明显。"],
        "adjustments": ["降低趋势权重，提高资金权重。"],
        "strategy_optimization": {
            "should_update": True,
            "error_reasons": ["高趋势评分未能转化为正收益。"],
            "adjustments": ["趋势权重降低 3，资金权重提高 3。"],
            "parameters": {
                "min_trade_score": 72,
                "trend_weight": 27,
                "structure_weight": 25,
                "capital_weight": 23,
                "macro_weight": 15,
                "news_weight": 10,
            },
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["text"]["format"]["name"] == "daily_review_with_strategy"
        assert body["text"]["format"]["strict"] is True
        return httpx.Response(200, json={
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(model_payload)}],
            }]
        })

    original_async_client = httpx.AsyncClient
    monkeypatch.setattr(ai_analysis, "get_settings", lambda: settings)
    monkeypatch.setattr(
        ai_analysis.httpx,
        "AsyncClient",
        lambda **kwargs: original_async_client(
            transport=httpx.MockTransport(handler), timeout=kwargs.get("timeout")
        ),
    )
    context = {
        "period": "2026-09-11",
        "strategy_optimization": {
            "sample_total": 20,
            "minimum_sample_size": 20,
            "current_parameters": DEFAULT_PARAMETERS,
            "safety_constraints": {"weights_must_total": 100},
        },
    }

    result = asyncio.run(ai_analysis.enrich_review_with_openai(review, context))

    assert result.summary == model_payload["summary"]
    assert result.adjustments == model_payload["adjustments"]
    assert result.metrics["analysis_engine"] == "openai"
    assert result.metrics["ai_strategy_proposal"]["should_update"] is True
    assert result.metrics["ai_strategy_proposal"]["parameters"]["capital_weight"] == 23
