import asyncio
import json
from types import SimpleNamespace

import httpx

from app import ai_analysis
from app.schemas import AnalysisRequest, MarketSnapshot, ReviewRecordResponse
from app.services import analyze_market


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
            "trend": 25,
            "structure": 21,
            "capital": 16,
            "macro": 11,
            "news": 7,
            "risk": "medium",
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
    assert result.direction == "SHORT"
    assert result.score == 80
    assert result.stop_loss > result.entry_range[1]
    assert result.take_profit[0] < result.entry_range[0]
    assert result.position_sizing.margin_amount > 0


def test_missing_ai_key_keeps_explicit_rule_engine(monkeypatch):
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

    result = asyncio.run(ai_analysis.enrich_analyses_with_openai(
        [base], {"TEST": market}, "4h", 10_000
    ))[0]

    assert result.analysis_engine == "rules"
    assert result.analysis_model is None


def test_openai_review_changes_text_but_not_verified_metrics(monkeypatch):
    review = ReviewRecordResponse.model_validate({
        "id": 7,
        "trade_id": 3,
        "review_type": "trade",
        "review_date": "2026-09-11",
        "result": "win",
        "summary": "规则复盘",
        "findings": ["真实退出价 110。", "净盈亏 9.8 USDC。"],
        "adjustments": ["保留当前规则。"],
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
