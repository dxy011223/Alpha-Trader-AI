import base64
import hashlib
import hmac
import logging
import time
from datetime import UTC, datetime
from urllib.parse import urlencode

import httpx

from app.platform_credentials import PlatformCredentialValues, PrivatePlatform
from app.schemas import WalletSnapshot

logger = logging.getLogger(__name__)
BINANCE_FUTURES_URL = "https://fapi.binance.com"
OKX_API_URL = "https://www.okx.com"


class FillHistoryIncompleteError(RuntimeError):
    """成交历史无法在受控分页范围内完整读取。"""


def _masked_account(platform: PrivatePlatform, api_key: str) -> str:
    hint = f"{api_key[:4]}…{api_key[-4:]}" if len(api_key) > 8 else "已配置"
    return f"{platform}:{hint}"


async def _binance_get(
    client: httpx.AsyncClient,
    path: str,
    credentials: PlatformCredentialValues,
    params: dict | None = None,
) -> dict | list:
    signed = dict(params or {})
    signed.update({"timestamp": int(time.time() * 1000), "recvWindow": 5000})
    query = urlencode(signed)
    signed["signature"] = hmac.new(
        credentials.secret_key.encode("utf-8"), query.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    response = await client.get(
        f"{BINANCE_FUTURES_URL}{path}",
        params=signed,
        headers={"X-MBX-APIKEY": credentials.api_key},
    )
    response.raise_for_status()
    return response.json()


async def _okx_get(
    client: httpx.AsyncClient,
    path: str,
    credentials: PlatformCredentialValues,
    params: dict | None = None,
) -> list:
    query = urlencode(params or {})
    request_path = f"{path}?{query}" if query else path
    timestamp = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    payload = f"{timestamp}GET{request_path}"
    signature = base64.b64encode(
        hmac.new(
            credentials.secret_key.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")
    response = await client.get(
        f"{OKX_API_URL}{request_path}",
        headers={
            "OK-ACCESS-KEY": credentials.api_key,
            "OK-ACCESS-SIGN": signature,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": credentials.passphrase or "",
        },
    )
    response.raise_for_status()
    body = response.json()
    if str(body.get("code")) != "0":
        raise RuntimeError(str(body.get("msg") or "OKX 返回错误"))
    return body.get("data", [])


def _binance_positions(items: list[dict]) -> list[dict]:
    positions = []
    for item in items:
        size = float(item.get("positionAmt") or 0)
        if abs(size) <= 0:
            continue
        symbol = str(item.get("symbol") or "")
        positions.append({
            "coin": symbol.removesuffix("USDT"),
            "szi": str(size),
            "entryPx": item.get("entryPrice") or "0",
            "positionValue": str(abs(float(item.get("notional") or 0))),
            "unrealizedPnl": item.get("unrealizedProfit") or "0",
            "leverage": {"value": int(float(item.get("leverage") or 1)), "type": "cross"},
        })
    return positions


def _okx_positions(items: list[dict], contract_values: dict[str, float]) -> list[dict]:
    positions = []
    for item in items:
        raw_size = float(item.get("pos") or 0)
        if abs(raw_size) <= 0:
            continue
        pos_side = str(item.get("posSide") or "net")
        base_size = raw_size * contract_values.get(str(item.get("instId") or ""), 1)
        size = -abs(base_size) if pos_side == "short" else base_size
        positions.append({
            "coin": str(item.get("instId") or "").split("-")[0],
            "szi": str(size),
            "entryPx": item.get("avgPx") or "0",
            "positionValue": str(abs(float(item.get("notionalUsd") or 0))),
            "unrealizedPnl": item.get("upl") or "0",
            "leverage": {"value": int(float(item.get("lever") or 1)), "type": item.get("mgnMode") or "cross"},
        })
    return positions


def _normalize_binance_fills(items: list[dict], symbol: str) -> list[dict]:
    return [
        {
            "coin": symbol.upper(),
            "px": item.get("price") or "0",
            "sz": item.get("qty") or "0",
            "side": "B" if bool(item.get("buyer")) else "A",
            "time": int(item.get("time") or 0),
            "fee": str(abs(float(item.get("commission") or 0))),
            "feeCurrency": str(item.get("commissionAsset") or "USDT").upper(),
            "closedPnl": item.get("realizedPnl") or "0",
            "dir": "exchange fill",
            "tid": item.get("id"),
            "orderId": item.get("orderId"),
            "positionSide": str(item.get("positionSide") or "BOTH").upper(),
        }
        for item in items
    ]


def _normalize_okx_fills(items: list[dict], symbol: str, contract_value: float = 1) -> list[dict]:
    return [
        {
            "coin": symbol.upper(),
            "px": item.get("fillPx") or "0",
            "sz": str(float(item.get("fillSz") or 0) * contract_value),
            "side": "B" if item.get("side") == "buy" else "A",
            "time": int(item.get("fillTime") or 0),
            "fee": str(abs(float(item.get("fee") or 0))),
            "feeCurrency": str(item.get("feeCcy") or "USDT").upper(),
            "closedPnl": item.get("fillPnl") or "0",
            "dir": "exchange fill",
            "tid": item.get("tradeId"),
            "orderId": item.get("ordId"),
            "positionSide": str(item.get("posSide") or "net").upper(),
        }
        for item in items
    ]


async def get_exchange_account(
    platform: PrivatePlatform,
    credentials: PlatformCredentialValues,
    symbol: str | None = None,
) -> WalletSnapshot:
    account = _masked_account(platform, credentials.api_key)
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            if platform == "binance":
                data = await _binance_get(client, "/fapi/v3/account", credentials)
                positions = _binance_positions(data.get("positions", []))
                history = []
                if symbol:
                    fills = await _binance_get(
                        client,
                        "/fapi/v1/userTrades",
                        credentials,
                        {"symbol": f"{symbol.upper()}USDT", "limit": 100},
                    )
                    history = _normalize_binance_fills(fills, symbol)
                return WalletSnapshot(
                    address=account,
                    equity=float(data.get("totalMarginBalance") or 0),
                    available_balance=float(data.get("availableBalance") or 0),
                    unrealized_pnl=float(data.get("totalUnrealizedProfit") or 0),
                    positions=positions,
                    history=history,
                    source="live",
                    platform=platform,
                )

            balance_rows = await _okx_get(client, "/api/v5/account/balance", credentials)
            position_rows = await _okx_get(
                client, "/api/v5/account/positions", credentials, {"instType": "SWAP"}
            )
            instrument_rows = await _okx_get(
                client, "/api/v5/public/instruments", credentials, {"instType": "SWAP"}
            )
            contract_values = {
                str(item.get("instId") or ""): float(item.get("ctVal") or 1)
                for item in instrument_rows
            }
            balance = balance_rows[0] if balance_rows else {}
            details = balance.get("details", [])
            available = sum(float(item.get("availEq") or 0) for item in details)
            history = []
            if symbol:
                fill_rows = await _okx_get(
                    client,
                    "/api/v5/trade/fills-history",
                    credentials,
                    {"instType": "SWAP", "instId": f"{symbol.upper()}-USDT-SWAP", "limit": 100},
                )
                history = _normalize_okx_fills(
                    fill_rows,
                    symbol,
                    contract_values.get(f"{symbol.upper()}-USDT-SWAP", 1),
                )
            positions = _okx_positions(position_rows, contract_values)
            return WalletSnapshot(
                address=account,
                equity=float(balance.get("totalEq") or 0),
                available_balance=available,
                unrealized_pnl=sum(float(item.get("unrealizedPnl") or 0) for item in positions),
                positions=positions,
                history=history,
                source="live",
                platform=platform,
            )
    except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError, RuntimeError) as exc:
        logger.warning("%s 只读账户数据获取失败：%s", platform, exc)
        return WalletSnapshot(
            address=account,
            equity=0,
            available_balance=0,
            unrealized_pnl=0,
            positions=[],
            history=[],
            source="unavailable",
            error=f"{platform} 只读账户数据暂时不可用",
            platform=platform,
        )


async def get_exchange_fills(
    platform: PrivatePlatform,
    credentials: PlatformCredentialValues,
    symbol: str,
    start_time: int,
) -> list[dict]:
    """读取决策开始后的真实成交；不调用任何下单或撤单接口。"""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            if platform == "binance":
                normalized: list[dict] = []
                next_id: int | None = None
                exhausted = True
                for _ in range(10):
                    params = {"symbol": f"{symbol.upper()}USDT", "limit": 1000}
                    if next_id is None:
                        params["startTime"] = start_time
                    else:
                        params["fromId"] = next_id
                    rows = await _binance_get(client, "/fapi/v1/userTrades", credentials, params)
                    if not isinstance(rows, list) or not rows:
                        exhausted = False
                        break
                    normalized.extend(_normalize_binance_fills(rows, symbol))
                    if len(rows) < 1000:
                        exhausted = False
                        break
                    candidate_id = max(int(item.get("id") or 0) for item in rows) + 1
                    if next_id is not None and candidate_id <= next_id:
                        raise FillHistoryIncompleteError("Binance 成交分页游标未推进，已拒绝生成不完整复盘")
                    next_id = candidate_id
                if exhausted:
                    raise FillHistoryIncompleteError("Binance 成交记录超过单次安全读取上限，请缩短跟踪周期后重试")
                return _deduplicate_fills(normalized, start_time)

            instrument = f"{symbol.upper()}-USDT-SWAP"
            instrument_rows = await _okx_get(
                client,
                "/api/v5/public/instruments",
                credentials,
                {"instType": "SWAP", "instId": instrument},
            )
            contract_value = float(instrument_rows[0].get("ctVal") or 1) if instrument_rows else 1
            normalized = []
            after: str | None = None
            exhausted = True
            for _ in range(10):
                params = {
                    "instType": "SWAP",
                    "instId": instrument,
                    "begin": start_time,
                    "limit": 100,
                }
                if after:
                    params["after"] = after
                rows = await _okx_get(client, "/api/v5/trade/fills-history", credentials, params)
                if not rows:
                    exhausted = False
                    break
                normalized.extend(_normalize_okx_fills(rows, symbol, contract_value))
                if len(rows) < 100:
                    exhausted = False
                    break
                candidate_after = str(rows[-1].get("billId") or rows[-1].get("tradeId") or "")
                if not candidate_after or candidate_after == after:
                    raise FillHistoryIncompleteError("OKX 成交分页游标未推进，已拒绝生成不完整复盘")
                after = candidate_after
            if exhausted:
                raise FillHistoryIncompleteError("OKX 成交记录超过单次安全读取上限，请缩短跟踪周期后重试")
            return _deduplicate_fills(normalized, start_time)
    except FillHistoryIncompleteError:
        raise
    except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError, RuntimeError) as exc:
        logger.warning("%s 真实成交数据获取失败：%s", platform, exc)
        raise RuntimeError(f"{platform} 真实成交数据暂时不可用") from exc


def _deduplicate_fills(items: list[dict], start_time: int) -> list[dict]:
    unique: dict[tuple, dict] = {}
    for item in items:
        if int(item.get("time") or 0) < start_time:
            continue
        key = (
            item.get("tid"), item.get("orderId"), item.get("time"),
            item.get("side"), item.get("px"), item.get("sz"),
        )
        unique[key] = item
    return sorted(unique.values(), key=lambda item: int(item.get("time") or 0))
