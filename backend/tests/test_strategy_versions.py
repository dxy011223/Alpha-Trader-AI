from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import strategy_versions
from app.database import Base
from app.models import CompletedTrade, ReviewRecord, TrackedDecision
from app.schemas import ReviewRecordResponse
from app.strategy_scoring import DEFAULT_PARAMETERS


def test_daily_performance_is_idempotent_before_minimum_sample(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'strategy.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(strategy_versions, "SessionLocal", testing_session)
    review = ReviewRecordResponse.model_validate({
        "id": 1,
        "trade_id": None,
        "review_type": "daily",
        "review_date": "2026-09-11",
        "result": "loss",
        "summary": "测试",
        "findings": [],
        "adjustments": ["继续收集真实交易样本。"],
        "metrics": {
            "platform": "hyperliquid",
            "total": 5,
            "wins": 1,
            "net_pnl": -10,
            "analysis_engine": "openai",
            "analysis_model": "test-model",
            "ai_strategy_proposal": {
                "should_update": False,
                "error_reasons": ["样本不足，无法形成稳定判断。"],
                "adjustments": ["继续收集真实交易样本。"],
                "parameters": DEFAULT_PARAMETERS,
            },
        },
        "created_at": "2026-09-11T00:00:00Z",
    })

    result = strategy_versions.record_daily_performance(review)
    duplicate = strategy_versions.record_daily_performance(result)

    assert result.metrics["strategy_optimization"]["status"] == "waiting_samples"
    assert duplicate.metrics["strategy_optimization"] == result.metrics["strategy_optimization"]
    version, parameters = strategy_versions.read_current_strategy()
    assert version == "v1"
    assert parameters["min_trade_score"] == 70


def test_ai_strategy_proposal_over_safety_delta_is_rejected():
    proposal = {
        "should_update": True,
        "error_reasons": ["AI 判断应显著提高门槛。"],
        "adjustments": ["提高可交易阈值。"],
        "parameters": {**DEFAULT_PARAMETERS, "min_trade_score": 80},
    }

    parameters, reason = strategy_versions._validate_ai_proposal(
        proposal, DEFAULT_PARAMETERS, 20
    )

    assert parameters is None
    assert reason == "AI 可交易阈值单次变化超过安全限制"


def test_recent_real_results_create_weighted_strategy_version(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'optimized-strategy.db'}")
    Base.metadata.create_all(engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(strategy_versions, "SessionLocal", testing_session)
    now = datetime.now(UTC)

    ai_adjustments = ["降低趋势维度权重，提高资金维度权重。"]
    review_metrics = {
        "platform": "hyperliquid",
        "total": 20,
        "wins": 5,
        "net_pnl": -25,
        "analysis_engine": "openai",
        "analysis_model": "test-model",
        "ai_strategy_proposal": {
            "should_update": True,
            "error_reasons": ["高趋势评分在亏损样本中出现频率更高。"],
            "adjustments": ai_adjustments,
            "parameters": {
                **DEFAULT_PARAMETERS,
                "min_trade_score": 72,
                "trend_weight": 27,
                "capital_weight": 23,
            },
        },
    }
    with testing_session.begin() as session:
        for index in range(20):
            winning = index < 5
            breakdown = {
                "trend": 6 if winning else 30,
                "structure": 10,
                "capital": 18 if winning else 4,
                "macro": 5,
                "news": 3,
            }
            decision = TrackedDecision(
                symbol="BTC",
                timeframe="4h",
                direction="LONG",
                confidence=sum(breakdown.values()),
                score=sum(breakdown.values()),
                analysis_snapshot={
                    "strategy_version": "v1",
                    "strategy_parameters": DEFAULT_PARAMETERS,
                    "score_breakdown": breakdown,
                },
                total_amount=Decimal("10000"),
                allocated_amount=Decimal("100"),
                status="completed",
                started_at=now - timedelta(hours=index + 2),
                completed_at=now - timedelta(hours=index + 1),
            )
            session.add(decision)
            session.flush()
            pnl = Decimal("1") if winning else Decimal("-2")
            session.add(CompletedTrade(
                decision_id=decision.id,
                position_id=index + 1,
                wallet_address="0x1111111111111111111111111111111111111111",
                symbol="BTC",
                direction="LONG",
                entry_price=Decimal("100"),
                exit_price=Decimal("101") if winning else Decimal("98"),
                size=Decimal("1"),
                fee=Decimal("0"),
                gross_pnl=pnl,
                net_pnl=pnl,
                pnl_percent=float(pnl),
                entry_source="hyperliquid",
                exit_source="hyperliquid",
                exchange_fills=[],
                closed_at=now - timedelta(hours=index),
            ))
        daily_record = ReviewRecord(
            trade_id=None,
            review_type="daily",
            review_date=now.date(),
            result="loss",
            summary="测试复盘",
            findings=[],
            adjustments=[],
            metrics=review_metrics,
            created_at=now,
        )
        second_platform_record = ReviewRecord(
            trade_id=None,
            review_type="daily",
            review_date=now.date(),
            result="loss",
            summary="另一平台测试复盘",
            findings=[],
            adjustments=[],
            metrics={**review_metrics, "platform": "binance"},
            created_at=now,
        )
        session.add_all([daily_record, second_platform_record])
        session.flush()
        review_id = daily_record.id
        second_review_id = second_platform_record.id

    review = ReviewRecordResponse.model_validate({
        "id": review_id,
        "trade_id": None,
        "review_type": "daily",
        "review_date": now.date(),
        "result": "loss",
        "summary": "测试复盘",
        "findings": [],
        "adjustments": ai_adjustments,
        "metrics": review_metrics,
        "created_at": now,
    })

    context = strategy_versions.build_strategy_optimization_context(review)
    result = strategy_versions.record_daily_performance(review)
    second_result = strategy_versions.record_daily_performance(
        review.model_copy(update={
            "id": second_review_id,
            "summary": "另一平台测试复盘",
            "metrics": {**review_metrics, "platform": "binance"},
        })
    )
    version, parameters = strategy_versions.read_current_strategy()
    history = strategy_versions.list_strategy_versions()

    assert version == "v2"
    assert context["current_version"] == "v1"
    assert context["sample_total"] == 20
    assert len(context["verified_trades"]) == 20
    assert [item.version for item in history] == ["v2", "v1"]
    assert result.metrics["strategy_optimization"]["status"] == "updated"
    assert second_result.metrics["strategy_optimization"] == result.metrics["strategy_optimization"]
    assert result.metrics["strategy_optimization"]["sample_total"] == 20
    assert parameters["min_trade_score"] == 72
    assert parameters["trend_weight"] == 27
    assert parameters["capital_weight"] == 23
    assert sum(parameters[f"{factor}_weight"] for factor in strategy_versions.SCORE_FACTORS) == 100
    assert result.adjustments == ai_adjustments
    assert result.metrics["strategy_optimization"]["analysis_model"] == "test-model"
