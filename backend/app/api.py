import asyncio
from datetime import UTC, date
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query

from app.ai_analysis import enrich_review_with_openai
from app.capital_settings import read_capital_settings, write_capital_settings
from app.exchange_accounts import get_exchange_account, get_exchange_fills
from app.news_archive import get_news_archive
from app.news_sources import current_news_date
from app.market_scanner import MarketScanBusy, get_cached_or_compute_market_scan
from app.security import require_owner, require_secure_transport
from app.platform_credentials import PrivatePlatform, read_platform_credential_status, read_platform_credentials, write_platform_credentials
from app.position_monitor import monitor_active_positions
from app.scan_cache import clear_market_scan_cache
from app.schemas import AnalysisRequest, AnalysisResponse, Candle, CapitalSettingsResponse, CapitalSettingsUpdate, CompletedTradeResponse, CompletionResponse, ExecutionCreate, ExecutionStateResponse, MarketSnapshot, NewsArchiveResponse, NewsItem, OpportunityScanResponse, PlatformCredentialResponse, PlatformCredentialUpdate, PositionMonitorResponse, ReviewRecordResponse, SimulationWalletResponse, SimulationWalletUpdate, StrategyVersionResponse, WalletSettingsResponse, WalletSettingsUpdate, WalletSnapshot
from app.simulation_wallet import read_simulation_wallet, write_simulation_wallet
from app.strategy_versions import (
    build_strategy_optimization_context,
    list_strategy_versions,
    read_current_strategy,
    record_daily_performance,
)
from app.services import MarketPlatform, analyze_market, calculate_technical_indicators, get_candles, get_live_market, get_live_wallet, get_user_fills_by_time, parse_history_policy, refresh_decision_plan
from app.trade_records import attach_wallet_to_active_position, cancel_execution, create_execution, finalize_position, generate_daily_review, list_completed_trades, list_review_records, read_active_execution, read_active_executions, read_open_position, update_review_content
from app.wallet_settings import read_wallet_settings, write_wallet_settings

router = APIRouter(prefix="/api/v1")


@router.get("/market/{symbol}", response_model=MarketSnapshot, summary="获取实时市场快照")
async def market_snapshot(
    symbol: str,
    platform: MarketPlatform = Query(default="hyperliquid"),
) -> MarketSnapshot:
    market = await get_live_market(symbol, platform)
    if market is None:
        raise HTTPException(status_code=404, detail="暂不支持该交易品种")
    return market


@router.get("/market/{symbol}/candles", response_model=list[Candle], summary="获取 K 线数据")
async def market_candles(
    symbol: str,
    interval: str = "1h",
    limit: int = 120,
    platform: MarketPlatform = Query(default="hyperliquid"),
) -> list[Candle]:
    if interval not in {"1m", "5m", "15m", "1h", "4h", "1d"}:
        raise HTTPException(status_code=422, detail="不支持的 K 线周期")
    return await get_candles(symbol, interval, min(max(limit, 1), 500), platform)


@router.get("/news/latest", response_model=list[NewsItem], summary="获取最新新闻分析")
def latest_news() -> list[NewsItem]:
    return get_news_archive(current_news_date()).items


@router.get("/news", response_model=NewsArchiveResponse, summary="按日期获取全部新闻归档")
def news_archive(
    target_date: date | None = Query(default=None, alias="date"),
    platform: MarketPlatform = Query(default="hyperliquid"),
) -> NewsArchiveResponse:
    archive = get_news_archive(target_date or current_news_date())
    return archive.model_copy(update={"platform": platform})


@router.get("/settings/capital", response_model=CapitalSettingsResponse, summary="读取总资金设置", dependencies=[Depends(require_owner)])
def capital_settings() -> CapitalSettingsResponse:
    return read_capital_settings()


@router.put("/settings/capital", response_model=CapitalSettingsResponse, summary="保存总资金设置", dependencies=[Depends(require_owner)])
def update_capital_settings(payload: CapitalSettingsUpdate) -> CapitalSettingsResponse:
    saved = write_capital_settings(payload)
    clear_market_scan_cache()
    return saved


@router.get("/settings/wallet", response_model=WalletSettingsResponse | None, summary="读取只读钱包设置", dependencies=[Depends(require_owner)])
def wallet_settings() -> WalletSettingsResponse | None:
    return read_wallet_settings()


@router.put("/settings/wallet", response_model=WalletSettingsResponse, summary="保存只读钱包地址", dependencies=[Depends(require_owner)])
def update_wallet_settings(payload: WalletSettingsUpdate) -> WalletSettingsResponse:
    settings = write_wallet_settings(payload)
    attach_wallet_to_active_position(settings.address)
    return settings


@router.get(
    "/simulation/wallet/{client_id}",
    response_model=SimulationWalletResponse,
    summary="读取模拟交易钱包",
    dependencies=[Depends(require_owner)],
)
def simulation_wallet(
    client_id: str = Path(pattern=r"^[A-Za-z0-9_-]{8,64}$"),
    platform: MarketPlatform = Query(default="hyperliquid"),
) -> SimulationWalletResponse:
    return read_simulation_wallet(client_id, platform)


@router.put(
    "/simulation/wallet/{client_id}",
    response_model=SimulationWalletResponse,
    summary="保存模拟交易钱包与交易记录",
    dependencies=[Depends(require_owner)],
)
def update_simulation_wallet(
    payload: SimulationWalletUpdate,
    client_id: str = Path(pattern=r"^[A-Za-z0-9_-]{8,64}$"),
    platform: MarketPlatform = Query(default="hyperliquid"),
) -> SimulationWalletResponse:
    return write_simulation_wallet(client_id, platform, payload)


@router.get(
    "/settings/platform/{platform}",
    response_model=PlatformCredentialResponse,
    summary="读取交易所只读凭证状态",
    dependencies=[Depends(require_owner)],
)
def platform_credential_status(platform: PrivatePlatform) -> PlatformCredentialResponse:
    return read_platform_credential_status(platform)


@router.put(
    "/settings/platform/{platform}",
    response_model=PlatformCredentialResponse,
    summary="加密保存交易所只读凭证",
    dependencies=[Depends(require_owner), Depends(require_secure_transport)],
)
def update_platform_credential(
    platform: PrivatePlatform, payload: PlatformCredentialUpdate
) -> PlatformCredentialResponse:
    try:
        status = write_platform_credentials(platform, payload)
        attach_wallet_to_active_position(
            f"{platform}:{status.api_key_hint or '已配置'}", platform
        )
        return status
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/executions/active", response_model=ExecutionStateResponse | None, summary="读取执行中的决策与持仓", dependencies=[Depends(require_owner)])
def active_execution(
    platform: MarketPlatform | None = Query(default=None),
) -> ExecutionStateResponse | None:
    return read_active_execution(platform)


@router.get("/executions/active/all", response_model=list[ExecutionStateResponse], summary="读取全部执行中的决策与持仓", dependencies=[Depends(require_owner)])
def active_executions(
    platform: MarketPlatform | None = Query(default=None),
) -> list[ExecutionStateResponse]:
    return read_active_executions(platform)


@router.get("/positions/monitor", response_model=list[PositionMonitorResponse], summary="刷新活动持仓管理建议", dependencies=[Depends(require_owner)])
async def position_monitors(
    platform: MarketPlatform | None = Query(default=None),
) -> list[PositionMonitorResponse]:
    return await monitor_active_positions(platform)


@router.post("/executions", response_model=ExecutionStateResponse, status_code=201, summary="开始跟踪决策", dependencies=[Depends(require_owner)])
async def start_execution(
    payload: ExecutionCreate,
    owner_capital: float | None = Header(
        default=None, alias="X-Alpha-Owner-Capital", gt=0, le=1_000_000_000
    ),
    history_policy_header: str | None = Header(
        default=None, alias="X-Alpha-History-Policy"
    ),
) -> ExecutionStateResponse:
    try:
        platform = payload.analysis.platform
        market, candles = await asyncio.gather(
            get_live_market(payload.analysis.symbol, platform),
            get_candles(payload.analysis.symbol, payload.timeframe, 220, platform),
        )
        if market is None:
            raise ValueError("当前平台不存在该交易品种")
        total_amount = owner_capital or read_capital_settings().total_amount
        indicators = calculate_technical_indicators(candles)
        if indicators.atr_percent is not None:
            market = market.model_copy(update={"volatility": indicators.atr_percent})
        verified_analysis = analyze_market(
            AnalysisRequest(
                symbol=payload.analysis.symbol,
                timeframe=payload.timeframe,
                platform=platform,
            ),
            market,
            total_amount,
            indicators,
            history_policy=parse_history_policy(
                history_policy_header, platform
            ),
        )
        verified_analysis = refresh_decision_plan(
            payload.analysis,
            verified_analysis,
            market.price,
            payload.timeframe,
            total_amount,
            candles=candles,
        )
        if not verified_analysis.is_executable:
            raise ValueError(f"当前决策不可执行：{verified_analysis.status_reason}")
        verified_payload = payload.model_copy(update={
            "analysis": verified_analysis,
            "total_amount": total_amount,
        })
        if platform == "hyperliquid":
            wallet = read_wallet_settings()
            account_reference = wallet.address if wallet else None
        else:
            status = read_platform_credential_status(platform)
            account_reference = (
                f"{platform}:{status.api_key_hint or '已配置'}" if status.configured else None
            )
        return create_execution(verified_payload, account_reference)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/executions/{decision_id}/cancel", response_model=ExecutionStateResponse, summary="取消决策跟踪", dependencies=[Depends(require_owner)])
def stop_execution(decision_id: int) -> ExecutionStateResponse:
    state = cancel_execution(decision_id)
    if state is None:
        raise HTTPException(status_code=404, detail="没有找到执行中的决策")
    return state


@router.post("/positions/{position_id}/complete", response_model=CompletionResponse, summary="按真实成交完成持仓并生成复盘", dependencies=[Depends(require_owner)])
async def complete_position(position_id: int) -> CompletionResponse:
    state = read_open_position(position_id)
    if state is None:
        raise HTTPException(status_code=404, detail="没有找到执行中的计划持仓")
    platform = state.decision.analysis.platform
    address = state.position.wallet_address
    if platform == "hyperliquid":
        if not address:
            raise HTTPException(status_code=409, detail="请先绑定 Hyperliquid 只读钱包")
        wallet = await get_live_wallet(address)
    else:
        credentials = read_platform_credentials(platform)
        if credentials is None:
            raise HTTPException(status_code=409, detail="请先配置当前平台的只读 API 凭证")
        wallet = await get_exchange_account(platform, credentials, state.position.symbol)
    if wallet.source != "live":
        raise HTTPException(status_code=503, detail=wallet.error or "交易所数据暂时不可用")
    still_open = any(
        str(position.get("coin") or "").upper() == state.position.symbol.upper()
        and abs(float(position.get("szi") or 0)) > 0
        for position in wallet.positions
    )
    if still_open:
        raise HTTPException(status_code=409, detail="交易所中该币种仍有未平持仓，不能完成复盘")

    started_at = state.position.created_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    if platform == "hyperliquid":
        fills = await get_user_fills_by_time(address, int(started_at.timestamp() * 1000))
    else:
        fills = await get_exchange_fills(
            platform,
            credentials,
            state.position.symbol,
            int(started_at.timestamp() * 1000),
        )
    try:
        completed = finalize_position(position_id, fills)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    ai_review = await enrich_review_with_openai(
        completed.review,
        {"trade": completed.trade.model_dump(mode="json")},
    )
    return CompletionResponse(
        trade=completed.trade,
        review=update_review_content(ai_review),
    )


@router.get("/trades/completed", response_model=list[CompletedTradeResponse], summary="读取已完成交易", dependencies=[Depends(require_owner)])
def completed_trades(
    limit: int = Query(default=100, ge=1, le=500),
    platform: MarketPlatform | None = Query(default=None),
) -> list[CompletedTradeResponse]:
    return list_completed_trades(limit, platform)


@router.get("/reviews", response_model=list[ReviewRecordResponse], summary="读取持久化复盘记录", dependencies=[Depends(require_owner)])
def reviews(
    limit: int = Query(default=100, ge=1, le=500),
    platform: MarketPlatform | None = Query(default=None),
) -> list[ReviewRecordResponse]:
    return list_review_records(limit, platform)


@router.get(
    "/strategies/versions",
    response_model=list[StrategyVersionResponse],
    summary="读取策略版本历史",
    dependencies=[Depends(require_owner)],
)
def strategy_versions(
    limit: int = Query(default=20, ge=1, le=100),
) -> list[StrategyVersionResponse]:
    return list_strategy_versions(limit)


@router.post("/ai/analyze", response_model=AnalysisResponse, summary="生成规则交易计划", dependencies=[Depends(require_owner)])
async def ai_analyze(
    payload: AnalysisRequest,
    owner_capital: float | None = Header(
        default=None, alias="X-Alpha-Owner-Capital", gt=0, le=1_000_000_000
    ),
    history_policy_header: str | None = Header(
        default=None, alias="X-Alpha-History-Policy"
    ),
) -> AnalysisResponse:
    market, candles = await asyncio.gather(
        get_live_market(payload.symbol, payload.platform),
        get_candles(payload.symbol, payload.timeframe, 220, payload.platform),
    )
    if market is None:
        raise HTTPException(status_code=404, detail="暂不支持该交易品种")
    total_amount = owner_capital or read_capital_settings().total_amount
    strategy_version, strategy_parameters = await asyncio.to_thread(read_current_strategy)
    indicators = calculate_technical_indicators(candles)
    if indicators.atr_percent is not None:
        market = market.model_copy(update={"volatility": indicators.atr_percent})
    return analyze_market(
        payload,
        market,
        total_amount,
        indicators,
        strategy_version=strategy_version,
        strategy_parameters=strategy_parameters,
        history_policy=parse_history_policy(
            history_policy_header, payload.platform
        ),
    )


@router.get("/ai/opportunities", response_model=OpportunityScanResponse, summary="扫描全市场交易机会", dependencies=[Depends(require_owner)])
async def ai_opportunities(
    timeframe: Literal["1m", "5m", "15m", "1h", "4h", "1d"] = "4h",
    limit: int = Query(default=8, ge=4, le=20),
    platform: MarketPlatform = Query(default="hyperliquid"),
    force_refresh: bool = Query(default=False, description="忽略短期扫描缓存并重新计算"),
    owner_capital: float | None = Header(
        default=None, alias="X-Alpha-Owner-Capital", gt=0, le=1_000_000_000
    ),
    history_policy_header: str | None = Header(
        default=None, alias="X-Alpha-History-Policy"
    ),
) -> OpportunityScanResponse:
    try:
        return await get_cached_or_compute_market_scan(
            timeframe,
            limit,
            platform,
            owner_capital,
            force_refresh,
            parse_history_policy(history_policy_header, platform),
        )
    except MarketScanBusy as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/wallet/{address}", response_model=WalletSnapshot, summary="读取 Hyperliquid 钱包", dependencies=[Depends(require_owner)])
async def wallet_snapshot(address: str) -> WalletSnapshot:
    if len(address) != 42 or not address.startswith("0x"):
        raise HTTPException(status_code=422, detail="钱包地址格式不正确")
    return await get_live_wallet(address)


@router.get(
    "/platforms/{platform}/account",
    response_model=WalletSnapshot,
    summary="读取交易所只读账户、持仓与成交",
    dependencies=[Depends(require_owner)],
)
async def exchange_account_snapshot(
    platform: PrivatePlatform,
    symbol: str | None = Query(default=None, min_length=1, max_length=32),
) -> WalletSnapshot:
    try:
        credentials = read_platform_credentials(platform)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if credentials is None:
        raise HTTPException(status_code=409, detail="尚未配置当前平台的只读 API 凭证")
    return await get_exchange_account(platform, credentials, symbol)


@router.post("/review/daily", response_model=ReviewRecordResponse, summary="生成并保存每日真实交易复盘", dependencies=[Depends(require_owner)])
async def daily_review(
    target_date: date | None = Query(default=None, alias="date"),
    platform: MarketPlatform = Query(default="hyperliquid"),
) -> ReviewRecordResponse:
    review = generate_daily_review(target_date or current_news_date(), platform)
    strategy_context = build_strategy_optimization_context(review)
    ai_review = await enrich_review_with_openai(review, {
        "period": review.review_date.isoformat(),
        "platform": platform,
        "strategy_optimization": strategy_context,
    })
    return record_daily_performance(update_review_content(ai_review))
