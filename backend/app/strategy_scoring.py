from math import floor


SCORE_FACTORS = ("trend", "structure", "capital", "macro", "news")
BASE_WEIGHTS = {
    "trend": 30,
    "structure": 25,
    "capital": 20,
    "macro": 15,
    "news": 10,
}
DEFAULT_PARAMETERS = {
    "min_trade_score": 70,
    **{f"{factor}_weight": weight for factor, weight in BASE_WEIGHTS.items()},
}
WEIGHT_LIMITS = {
    "trend": (18, 40),
    "structure": (15, 35),
    "capital": (12, 30),
    "macro": (8, 25),
    "news": (5, 20),
}


def normalize_strategy_parameters(parameters: dict | None) -> dict:
    """兼容旧策略记录，并把五维权重规范为总和 100 的整数。"""
    merged = {**DEFAULT_PARAMETERS, **(parameters or {})}
    raw_weights = {
        factor: max(1.0, float(merged.get(f"{factor}_weight", default)))
        for factor, default in BASE_WEIGHTS.items()
    }
    total = sum(raw_weights.values())
    exact = {factor: value / total * 100 for factor, value in raw_weights.items()}
    weights = {factor: floor(value) for factor, value in exact.items()}
    remainder = 100 - sum(weights.values())
    for factor in sorted(SCORE_FACTORS, key=lambda item: exact[item] - weights[item], reverse=True)[:remainder]:
        weights[factor] += 1
    return {
        **merged,
        "min_trade_score": max(70, min(80, int(merged.get("min_trade_score", 70)))),
        **{f"{factor}_weight": weights[factor] for factor in SCORE_FACTORS},
    }


def read_strategy_weights(parameters: dict | None) -> dict[str, int]:
    normalized = normalize_strategy_parameters(parameters)
    return {factor: int(normalized[f"{factor}_weight"]) for factor in SCORE_FACTORS}


def apply_strategy_weights(raw_breakdown: dict[str, int], parameters: dict | None) -> dict[str, int]:
    """把企划中的五维原始评分按当前策略权重重新折算，总分保持在 0–100。"""
    weights = read_strategy_weights(parameters)
    exact = {
        factor: max(0.0, min(1.0, float(raw_breakdown.get(factor, 0)) / BASE_WEIGHTS[factor]))
        * weights[factor]
        for factor in SCORE_FACTORS
    }
    result = {factor: floor(value) for factor, value in exact.items()}
    target_total = round(sum(exact.values()))
    remainder = target_total - sum(result.values())
    for factor in sorted(SCORE_FACTORS, key=lambda item: exact[item] - result[item], reverse=True)[:remainder]:
        result[factor] += 1
    return result
