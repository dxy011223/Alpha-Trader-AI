from types import SimpleNamespace

from app import scan_cache
from app.schemas import OpportunityScanResponse


class FakeRedis:
    def __init__(self):
        self.values: dict[str, str] = {}

    def setex(self, key: str, _ttl: int, value: str) -> None:
        self.values[key] = value

    def get(self, key: str) -> str | None:
        return self.values.get(key)

    def close(self) -> None:
        pass

    def set(self, key: str, value: str, *, nx: bool, ex: int) -> bool:
        assert nx is True and ex == 90
        if key in self.values:
            return False
        self.values[key] = value
        return True

    def eval(self, _script: str, _key_count: int, key: str, token: str) -> int:
        if self.values.get(key) != token:
            return 0
        del self.values[key]
        return 1


def test_scan_cache_round_trip(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(scan_cache, "get_settings", lambda: SimpleNamespace(
        redis_url="redis://test",
        market_scan_cache_seconds=360,
    ))
    monkeypatch.setattr(scan_cache.Redis, "from_url", lambda *_args, **_kwargs: fake)
    scan = OpportunityScanResponse(
        scanned_markets=100,
        eligible_markets=80,
        updated_at="2026-09-11T00:00:00Z",
        opportunities=[],
    )

    scan_cache.write_timeframe_scan_cache("4h", scan)
    cached = scan_cache.read_scan_cache("4h", 8)

    assert cached is not None
    assert cached.scanned_markets == 100
    assert cached.scan_source == "scheduled_cache"


def test_decision_plan_cache_uses_a_separate_long_lived_key(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(scan_cache, "get_settings", lambda: SimpleNamespace(
        redis_url="redis://test",
        market_scan_cache_seconds=360,
    ))
    monkeypatch.setattr(scan_cache.Redis, "from_url", lambda *_args, **_kwargs: fake)
    scan = OpportunityScanResponse(
        scanned_markets=100,
        eligible_markets=80,
        updated_at="2026-09-13T00:00:00Z",
        opportunities=[],
    )

    scan_cache.write_decision_plan_cache("4h", scan)
    cached = scan_cache.read_decision_plan_cache("4h")

    assert cached is not None
    assert cached.updated_at == scan.updated_at
    assert "alpha-trader:decision-plans:hyperliquid:4h" in fake.values


def test_scan_lock_uses_owner_token_when_releasing(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(scan_cache, "get_settings", lambda: SimpleNamespace(
        redis_url="redis://test",
        market_scan_cache_seconds=360,
    ))
    monkeypatch.setattr(scan_cache.Redis, "from_url", lambda *_args, **_kwargs: fake)

    token = scan_cache.acquire_scan_lock("4h", "hyperliquid")
    assert token
    assert scan_cache.acquire_scan_lock("4h", "hyperliquid") == ""
    scan_cache.release_scan_lock("4h", "hyperliquid", "wrong-token")
    assert scan_cache.acquire_scan_lock("4h", "hyperliquid") == ""
    scan_cache.release_scan_lock("4h", "hyperliquid", token)
    assert scan_cache.acquire_scan_lock("4h", "hyperliquid")
