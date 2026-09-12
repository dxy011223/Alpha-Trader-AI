from app.strategy_scoring import apply_strategy_weights, normalize_strategy_parameters


def test_adjusted_weights_change_factor_contributions_and_keep_total_bounded():
    parameters = normalize_strategy_parameters({
        "trend_weight": 27,
        "structure_weight": 25,
        "capital_weight": 23,
        "macro_weight": 15,
        "news_weight": 10,
    })
    weighted = apply_strategy_weights({
        "trend": 24,
        "structure": 20,
        "capital": 15,
        "macro": 10,
        "news": 7,
    }, parameters)

    assert weighted["trend"] == 22
    assert weighted["capital"] == 17
    assert sum(weighted.values()) <= 100
    assert sum(parameters[f"{factor}_weight"] for factor in weighted) == 100
