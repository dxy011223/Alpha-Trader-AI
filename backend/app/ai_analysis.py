import asyncio
import json
import logging
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.news_sources import fetch_live_news
from app.security import AIBudgetUnavailable, ai_call_slot
from app.schemas import AnalysisResponse, MarketSnapshot, ReviewRecordResponse, ScoreBreakdown
from app.services import build_execution_levels, calculate_position_sizing

logger = logging.getLogger(__name__)


class ModelDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str
    direction: Literal["LONG", "SHORT", "WAIT"]
    confidence: int = Field(ge=0, le=100)
    trend: int = Field(ge=0, le=30)
    structure: int = Field(ge=0, le=25)
    capital: int = Field(ge=0, le=20)
    macro: int = Field(ge=0, le=15)
    news: int = Field(ge=0, le=10)
    risk: Literal["low", "medium", "high"]
    reasons: list[str] = Field(min_length=2, max_length=4)


class ModelDecisionBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decisions: list[ModelDecision]


class ModelReview(BaseModel):
    """AI 只能补充复盘文本，已核验的交易指标不进入模型输出结构。"""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=240)
    findings: list[str] = Field(min_length=2, max_length=5)
    adjustments: list[str] = Field(min_length=1, max_length=4)


def _extract_output_text(payload: dict) -> str:
    for output_item in payload.get("output", []):
        if output_item.get("type") != "message":
            continue
        for content_item in output_item.get("content", []):
            if content_item.get("type") == "output_text" and content_item.get("text"):
                return str(content_item["text"])
    raise ValueError("模型响应中没有可解析的文本输出")


def _apply_model_decision(
    base: AnalysisResponse,
    market: MarketSnapshot,
    decision: ModelDecision,
    total_amount: float,
    model: str,
) -> AnalysisResponse:
    breakdown = ScoreBreakdown(
        trend=decision.trend,
        structure=decision.structure,
        capital=decision.capital,
        macro=decision.macro,
        news=decision.news,
    )
    score = sum(breakdown.model_dump().values())
    direction = decision.direction if score >= 70 else "WAIT"
    entry_range, stop_loss, take_profit = build_execution_levels(market, direction, decision.risk)
    leverage = 2 if decision.risk == "high" else 3 if decision.risk == "medium" else 4
    sizing = calculate_position_sizing(
        total_amount=total_amount,
        direction=direction,
        confidence=decision.confidence,
        risk=decision.risk,
        entry_range=entry_range,
        stop_loss=stop_loss,
        leverage=leverage,
    )
    return AnalysisResponse.model_validate({
        **base.model_dump(),
        "direction": direction,
        "confidence": decision.confidence,
        "score": score,
        "score_breakdown": breakdown,
        "entry_range": entry_range,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "leverage": leverage,
        "risk": decision.risk,
        "position_sizing": sizing,
        "reasons": [reason.strip() for reason in decision.reasons if reason.strip()],
        "analysis_engine": "openai",
        "analysis_model": model,
    })


async def enrich_analyses_with_openai(
    analyses: list[AnalysisResponse],
    markets: dict[str, MarketSnapshot],
    timeframe: str,
    total_amount: float,
) -> list[AnalysisResponse]:
    """让模型评估有限候选集；价格边界与仓位始终由本地风险公式生成。"""
    settings = get_settings()
    if not settings.ai_api_key or not analyses:
        return analyses

    news_items = await asyncio.to_thread(fetch_live_news)
    context = {
        "timeframe": timeframe,
        "markets": [
            {
                "symbol": item.symbol,
                "price": markets[item.symbol].price,
                "change_24h": markets[item.symbol].change_24h,
                "volume": markets[item.symbol].volume,
                "volatility": markets[item.symbol].volatility,
                "funding_rate": markets[item.symbol].funding_rate,
                "open_interest": markets[item.symbol].open_interest,
                "indicators": item.indicators.model_dump() if item.indicators else None,
            }
            for item in analyses
            if item.symbol in markets
        ],
        "recent_news": [
            {
                "title": item.title,
                "source": item.source,
                "published_at": item.published_at,
                "assets": item.assets,
                "direction": item.direction,
                "impact": item.impact,
            }
            for item in news_items[:12]
        ],
    }
    request_body = {
        "model": settings.ai_model,
        "store": False,
        "instructions": (
            "你是只读交易研究助手。只能根据提供的实时市场快照和新闻元数据评估机会，"
            "不得声称已下单或保证收益。必须逐一返回所有候选币种，理由使用简洁中文。"
        ),
        "input": json.dumps(context, ensure_ascii=False),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "market_decisions",
                "strict": True,
                "schema": ModelDecisionBatch.model_json_schema(),
            }
        },
        "max_output_tokens": 2400,
    }

    try:
        async with ai_call_slot():
            async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
                response = await client.post(
                    f"{settings.ai_base_url.rstrip('/')}/responses",
                    headers={"Authorization": f"Bearer {settings.ai_api_key}"},
                    json=request_body,
                )
                response.raise_for_status()
        model_results = ModelDecisionBatch.model_validate_json(_extract_output_text(response.json()))
    except (AIBudgetUnavailable, httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("OpenAI 决策分析失败，已安全回退到规则评分：%s", exc)
        return analyses

    decisions = {item.symbol.upper(): item for item in model_results.decisions}
    enriched: list[AnalysisResponse] = []
    for base in analyses:
        market = markets.get(base.symbol)
        decision = decisions.get(base.symbol)
        if market is None or decision is None:
            enriched.append(base)
            continue
        enriched.append(_apply_model_decision(base, market, decision, total_amount, settings.ai_model))
    return enriched


async def enrich_review_with_openai(
    review: ReviewRecordResponse,
    context: dict,
) -> ReviewRecordResponse:
    """用 AI 解释真实复盘指标；AI 不得修改成交事实与盈亏计算。"""
    settings = get_settings()
    fallback = review.model_copy(update={
        "metrics": {
            **review.metrics,
            "analysis_engine": "rules",
            "analysis_model": None,
        }
    })
    if not settings.ai_api_key:
        return fallback

    request_body = {
        "model": settings.ai_model,
        "store": False,
        "instructions": (
            "你是只读交易复盘助手。verified_metrics 和 context 均为后端核验的不可修改事实。"
            "只输出中文总结、关键发现和下次改进建议，不得虚构成交、修改数值、保证收益或声称已执行交易。"
        ),
        "input": json.dumps({
            "review_type": review.review_type,
            "result": review.result,
            "verified_metrics": review.metrics,
            "context": context,
            "rule_review": {
                "summary": review.summary,
                "findings": review.findings,
                "adjustments": review.adjustments,
            },
        }, ensure_ascii=False, default=str),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "trade_review",
                "strict": True,
                "schema": ModelReview.model_json_schema(),
            }
        },
        "max_output_tokens": 1200,
    }

    try:
        async with ai_call_slot():
            async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
                response = await client.post(
                    f"{settings.ai_base_url.rstrip('/')}/responses",
                    headers={"Authorization": f"Bearer {settings.ai_api_key}"},
                    json=request_body,
                )
                response.raise_for_status()
        model_review = ModelReview.model_validate_json(_extract_output_text(response.json()))
    except (AIBudgetUnavailable, httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("OpenAI 交易复盘失败，已保留真实规则复盘：%s", exc)
        return fallback

    return fallback.model_copy(update={
        "summary": model_review.summary.strip(),
        "findings": [item.strip() for item in model_review.findings if item.strip()],
        "adjustments": [item.strip() for item in model_review.adjustments if item.strip()],
        "metrics": {
            **review.metrics,
            "analysis_engine": "openai",
            "analysis_model": settings.ai_model,
        },
    })
