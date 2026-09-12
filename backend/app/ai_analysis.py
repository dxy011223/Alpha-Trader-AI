import asyncio
import json
import logging
import math
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config import get_settings
from app.news_sources import fetch_live_news
from app.security import AIBudgetUnavailable, ai_call_slot
from app.schemas import AnalysisRequest, AnalysisResponse, MarketSnapshot, PositionSizing, ReviewRecordResponse, ScoreBreakdown, TechnicalIndicators
from app.strategy_scoring import normalize_strategy_parameters

logger = logging.getLogger(__name__)


class AIDecisionUnavailable(RuntimeError):
    """AI 无法生成经过校验的决策时，禁止回退到规则结果。"""


class ModelPositionSizing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    risk_budget_rate: float = Field(ge=0, le=0.02)
    risk_budget_amount: float = Field(ge=0)
    stop_distance_rate: float = Field(ge=0, le=1)
    margin_amount: float = Field(ge=0)
    position_value: float = Field(ge=0)
    max_loss_amount: float = Field(ge=0)
    margin_cap_rate: float = Field(ge=0, le=1)
    capped: bool


class ModelDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str
    direction: Literal["LONG", "SHORT", "WAIT"]
    confidence: int = Field(ge=0, le=100)
    score: int = Field(ge=0, le=100)
    trend: int = Field(ge=0, le=40)
    structure: int = Field(ge=0, le=40)
    capital: int = Field(ge=0, le=40)
    macro: int = Field(ge=0, le=40)
    news: int = Field(ge=0, le=40)
    entry_range: list[float] = Field(min_length=2, max_length=2)
    stop_loss: float = Field(gt=0)
    take_profit: list[float] = Field(min_length=2, max_length=2)
    leverage: int = Field(ge=1, le=20)
    risk: Literal["low", "medium", "high"]
    position_sizing: ModelPositionSizing
    reasons: list[str] = Field(min_length=2, max_length=4)


class ModelDecisionBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decisions: list[ModelDecision]


class ModelPositionDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str
    action: Literal["HOLD", "REDUCE", "EXIT", "ADJUST_SL", "ADJUST_TP"]
    current_score: int = Field(ge=0, le=100)
    reason: str = Field(min_length=1, max_length=240)


class ModelPositionDecisionBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decisions: list[ModelPositionDecision]


class ModelReview(BaseModel):
    """AI 只能补充复盘文本，已核验的交易指标不进入模型输出结构。"""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=240)
    findings: list[str] = Field(min_length=2, max_length=5)
    adjustments: list[str] = Field(min_length=1, max_length=4)


class ModelStrategyParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min_trade_score: int = Field(ge=70, le=80)
    trend_weight: int = Field(ge=18, le=40)
    structure_weight: int = Field(ge=15, le=35)
    capital_weight: int = Field(ge=12, le=30)
    macro_weight: int = Field(ge=8, le=25)
    news_weight: int = Field(ge=5, le=20)

    @model_validator(mode="after")
    def validate_total_weight(self):
        total = (
            self.trend_weight
            + self.structure_weight
            + self.capital_weight
            + self.macro_weight
            + self.news_weight
        )
        if total != 100:
            raise ValueError("五维权重合计必须为 100")
        return self


class ModelStrategyOptimization(BaseModel):
    model_config = ConfigDict(extra="forbid")

    should_update: bool
    error_reasons: list[str] = Field(min_length=1, max_length=5)
    adjustments: list[str] = Field(min_length=1, max_length=5)
    parameters: ModelStrategyParameters


class ModelDailyReview(ModelReview):
    strategy_optimization: ModelStrategyOptimization


def _extract_output_text(payload: dict) -> str:
    for output_item in payload.get("output", []):
        if output_item.get("type") != "message":
            continue
        for content_item in output_item.get("content", []):
            if content_item.get("type") == "output_text" and content_item.get("text"):
                return str(content_item["text"])
    raise ValueError("模型响应中没有可解析的文本输出")


def build_ai_decision_context(
    request: AnalysisRequest,
    market: MarketSnapshot,
    indicators: TechnicalIndicators | None,
    strategy_version: str,
    strategy_parameters: dict | None,
) -> AnalysisResponse:
    """构造无方向、无评分的 AI 输入载体，不在本地预生成交易决策。"""
    price = market.price
    return AnalysisResponse(
        symbol=request.symbol.upper(),
        instrument=f"{request.symbol.upper()}-PERP",
        direction="WAIT",
        confidence=0,
        score=0,
        score_breakdown={"trend": 0, "structure": 0, "capital": 0, "macro": 0, "news": 0},
        entry_range=[price, price],
        stop_loss=price,
        take_profit=[price, price],
        leverage=1,
        risk="low",
        position_sizing={
            "risk_budget_rate": 0,
            "risk_budget_amount": 0,
            "stop_distance_rate": 0,
            "margin_amount": 0,
            "position_value": 0,
            "max_loss_amount": 0,
            "margin_cap_rate": 0,
            "capped": False,
        },
        indicators=indicators,
        reasons=["等待 AI 生成完整决策。"],
        disclaimer="仅供研究与辅助决策，不构成投资建议；系统不会自动向交易所下单。",
        source=market.source,
        platform=market.platform,
        strategy_version=strategy_version,
        strategy_parameters=normalize_strategy_parameters(strategy_parameters),
    )


def _apply_model_decision(
    base: AnalysisResponse,
    market: MarketSnapshot,
    decision: ModelDecision,
    total_amount: float,
    model: str,
) -> AnalysisResponse:
    parameters = normalize_strategy_parameters(base.strategy_parameters)
    breakdown = ScoreBreakdown.model_validate({
        "trend": decision.trend,
        "structure": decision.structure,
        "capital": decision.capital,
        "macro": decision.macro,
        "news": decision.news,
    })
    score = sum(breakdown.model_dump().values())
    if score != decision.score:
        raise ValueError("AI 总评分与五维评分之和不一致")
    for factor in ("trend", "structure", "capital", "macro", "news"):
        if getattr(decision, factor) > int(parameters[f"{factor}_weight"]):
            raise ValueError(f"AI 的 {factor} 评分超过当前策略权重")
    if decision.direction != "WAIT" and score < int(parameters["min_trade_score"]):
        raise ValueError("AI 可执行方向未达到当前策略评分阈值")

    entry_range = sorted(decision.entry_range)
    take_profit = decision.take_profit
    if entry_range[0] <= 0:
        raise ValueError("AI 入场区间必须为正数")
    if decision.direction == "LONG" and not (
        decision.stop_loss < entry_range[0]
        and take_profit[0] > entry_range[1]
        and take_profit[1] > take_profit[0]
    ):
        raise ValueError("AI 多头计划的止损或止盈边界无效")
    if decision.direction == "SHORT" and not (
        decision.stop_loss > entry_range[1]
        and take_profit[0] < entry_range[0]
        and take_profit[1] < take_profit[0]
    ):
        raise ValueError("AI 空头计划的止损或止盈边界无效")

    sizing = PositionSizing.model_validate(decision.position_sizing.model_dump())
    if decision.direction == "WAIT":
        if sizing.margin_amount != 0 or sizing.position_value != 0 or sizing.max_loss_amount != 0:
            raise ValueError("AI 观望决策不得分配仓位")
    else:
        entry_mid = sum(entry_range) / 2
        expected_stop_rate = abs(entry_mid - decision.stop_loss) / entry_mid
        expected_position_value = sizing.margin_amount * decision.leverage
        if sizing.margin_amount <= 0 or sizing.position_value <= 0:
            raise ValueError("AI 可执行决策必须给出有效仓位")
        if not math.isclose(sizing.stop_distance_rate, expected_stop_rate, rel_tol=0.02, abs_tol=0.000001):
            raise ValueError("AI 止损距离计算不一致")
        if not math.isclose(sizing.position_value, expected_position_value, rel_tol=0.02, abs_tol=0.01):
            raise ValueError("AI 开仓价值与保证金、杠杆不一致")
        if total_amount > 0 and not math.isclose(
            sizing.risk_budget_amount,
            total_amount * sizing.risk_budget_rate,
            rel_tol=0.02,
            abs_tol=0.01,
        ):
            raise ValueError("AI 风险预算金额计算不一致")
        expected_max_loss = sizing.position_value * sizing.stop_distance_rate
        if not math.isclose(sizing.max_loss_amount, expected_max_loss, rel_tol=0.03, abs_tol=0.01):
            raise ValueError("AI 最大计划亏损计算不一致")
        if total_amount > 0:
            margin_cap = total_amount * sizing.margin_cap_rate
            uncapped_margin = sizing.risk_budget_amount / sizing.stop_distance_rate / decision.leverage
            expected_margin = min(uncapped_margin, margin_cap)
            if not math.isclose(sizing.margin_amount, expected_margin, rel_tol=0.03, abs_tol=0.01):
                raise ValueError("AI 保证金与风险预算或上限计算不一致")
            if sizing.capped != (uncapped_margin > margin_cap):
                raise ValueError("AI 保证金上限状态计算不一致")

    return AnalysisResponse.model_validate({
        **base.model_dump(),
        "direction": decision.direction,
        "confidence": decision.confidence,
        "score": score,
        "score_breakdown": breakdown,
        "entry_range": entry_range,
        "stop_loss": decision.stop_loss,
        "take_profit": take_profit,
        "leverage": decision.leverage,
        "risk": decision.risk,
        "position_sizing": sizing,
        "reasons": [reason.strip() for reason in decision.reasons if reason.strip()],
        "analysis_engine": "openai",
        "analysis_model": model,
        "decision_schema_version": "ai_full_v1",
        "strategy_parameters": parameters,
    })


async def enrich_analyses_with_openai(
    analyses: list[AnalysisResponse],
    markets: dict[str, MarketSnapshot],
    timeframe: str,
    total_amount: float,
) -> list[AnalysisResponse]:
    """让 AI 独立生成完整决策；本地只校验结构、边界和数学一致性。"""
    settings = get_settings()
    if not analyses:
        return []
    if not settings.ai_api_key:
        raise AIDecisionUnavailable("AI 决策服务未配置，无法生成交易决策")

    news_items = await asyncio.to_thread(fetch_live_news)
    context = {
        "timeframe": timeframe,
        "total_amount": total_amount,
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
                "strategy_version": item.strategy_version,
                "strategy_parameters": normalize_strategy_parameters(item.strategy_parameters),
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
            "你是本系统唯一的交易决策与计算引擎。根据提供的市场快照、技术指标、新闻、"
            "资金和策略参数，独立制定每个候选币种的方向、五维评分、总评分、置信度、"
            "入场区间、止损、两个止盈、杠杆、风险等级和完整仓位计算。五维单项不得超过"
            "对应 strategy_parameters 权重，总评分必须等于五维之和；低于 min_trade_score"
            "必须 WAIT。LONG 的止损低于入场且止盈递增，SHORT 相反。仓位字段必须满足："
            "风险预算金额=总资金×风险预算率，开仓价值=保证金×杠杆，最大亏损=开仓价值×"
            "止损距离率。WAIT 的保证金、开仓价值和最大亏损均为 0。不得声称已下单或保证"
            "收益，必须逐一返回所有候选币种，理由使用简洁中文。"
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
        "max_output_tokens": 6000,
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
        logger.warning("AI 决策生成失败，已阻止规则结果回退：%s", exc)
        raise AIDecisionUnavailable("AI 决策暂时不可用，请稍后重试") from exc

    decisions = {item.symbol.upper(): item for item in model_results.decisions}
    expected_symbols = {item.symbol for item in analyses}
    if len(decisions) != len(model_results.decisions) or set(decisions) != expected_symbols:
        raise AIDecisionUnavailable("AI 返回的决策币种不完整，请重新生成")
    enriched: list[AnalysisResponse] = []
    for base in analyses:
        market = markets.get(base.symbol)
        decision = decisions.get(base.symbol)
        if market is None or decision is None:
            raise AIDecisionUnavailable("AI 决策所需的市场数据不完整")
        try:
            enriched.append(_apply_model_decision(base, market, decision, total_amount, settings.ai_model))
        except (ValueError, TypeError) as exc:
            logger.warning("AI 决策校验失败，已拒绝返回：%s", exc)
            raise AIDecisionUnavailable("AI 决策计算校验失败，请重新生成") from exc
    return enriched


async def generate_position_decisions_with_openai(
    position_contexts: list[dict],
) -> dict[str, ModelPositionDecision]:
    """由 AI 生成全部持仓管理动作；本地不使用评分规则替代。"""
    if not position_contexts:
        return {}
    settings = get_settings()
    if not settings.ai_api_key:
        raise AIDecisionUnavailable("AI 决策服务未配置，无法生成持仓管理决策")
    request_body = {
        "model": settings.ai_model,
        "store": False,
        "instructions": (
            "你是本系统唯一的持仓管理决策引擎。逐一评估输入持仓，返回当前总评分、唯一动作"
            "和简洁中文理由。动作仅可为 HOLD、REDUCE、EXIT、ADJUST_SL、ADJUST_TP。价格已触及"
            "止损或最终止盈时必须 EXIT；不得声称已操作交易所账户。"
        ),
        "input": json.dumps({"positions": position_contexts}, ensure_ascii=False, default=str),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "position_decisions",
                "strict": True,
                "schema": ModelPositionDecisionBatch.model_json_schema(),
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
        result = ModelPositionDecisionBatch.model_validate_json(_extract_output_text(response.json()))
    except (AIBudgetUnavailable, httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("AI 持仓管理决策生成失败：%s", exc)
        raise AIDecisionUnavailable("AI 持仓管理决策暂时不可用，请稍后重试") from exc

    decisions = {item.symbol.upper(): item for item in result.decisions}
    expected_symbols = {str(item["symbol"]).upper() for item in position_contexts}
    if len(decisions) != len(result.decisions) or set(decisions) != expected_symbols:
        raise AIDecisionUnavailable("AI 返回的持仓管理决策不完整，请重新生成")
    return decisions


async def enrich_review_with_openai(
    review: ReviewRecordResponse,
    context: dict,
) -> ReviewRecordResponse:
    """由 AI 完成事实以外的复盘内容，并可为每日复盘提出受限调参方案。"""
    settings = get_settings()
    strategy_context = context.get("strategy_optimization")
    daily_with_strategy = review.review_type == "daily" and isinstance(strategy_context, dict)
    output_model = ModelDailyReview if daily_with_strategy else ModelReview
    fallback = review.model_copy(update={
        "metrics": {
            **review.metrics,
            "analysis_engine": "facts",
            "analysis_model": None,
        }
    })
    if not settings.ai_api_key:
        return fallback

    request_body = {
        "model": settings.ai_model,
        "store": False,
        "instructions": (
            "你是只读交易复盘与策略优化助手。verified_metrics、verified_fact_record 和 context "
            "均为后端核验的不可修改事实。除这些事实外，复盘总结、错误归因、改进建议和策略优化"
            "必须全部由你完成。不得虚构成交、修改事实、保证收益或声称已执行交易。"
            "只有 context.strategy_optimization.sample_total 达到 minimum_sample_size 时才可将 "
            "should_update 设为 true；否则必须保留 current_parameters。调参必须满足 safety_constraints，"
            "且完整返回五维权重与阈值。"
        ),
        "input": json.dumps({
            "review_type": review.review_type,
            "result": review.result,
            "verified_metrics": review.metrics,
            "context": context,
            "verified_fact_record": {
                "summary": review.summary,
                "findings": review.findings,
            },
        }, ensure_ascii=False, default=str),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "daily_review_with_strategy" if daily_with_strategy else "trade_review",
                "strict": True,
                "schema": output_model.model_json_schema(),
            }
        },
        "max_output_tokens": 2200 if daily_with_strategy else 1200,
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
        model_review = output_model.model_validate_json(_extract_output_text(response.json()))
    except (AIBudgetUnavailable, httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("OpenAI 交易复盘失败，已仅保留核验交易事实：%s", exc)
        return fallback

    return fallback.model_copy(update={
        "summary": model_review.summary.strip(),
        "findings": [item.strip() for item in model_review.findings if item.strip()],
        "adjustments": [item.strip() for item in model_review.adjustments if item.strip()],
        "metrics": {
            **review.metrics,
            "analysis_engine": "openai",
            "analysis_model": settings.ai_model,
            **(
                {
                    "ai_strategy_proposal": model_review.strategy_optimization.model_dump()
                }
                if isinstance(model_review, ModelDailyReview)
                else {}
            ),
        },
    })
