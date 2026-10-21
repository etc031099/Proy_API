"""Read integer evidence from an already validated frozen artifact; never mine."""
from __future__ import annotations

import math
from typing import Any


def rule_evidence(artifact: dict[str, Any], rule: dict[str, Any]) -> dict[str, Any]:
    counts = {tuple(sorted(row["itemSkus"])): row["ticketCount"]
              for row in artifact["frequentItemsets"]}
    antecedent = rule.get("antecedentSkus") or [rule["sourceSku"]]
    consequent = rule.get("consequentSkus") or [rule["recommendedSku"]]
    n = artifact["transactionCount"]
    a = counts[tuple(sorted(set(antecedent)))]
    b = counts[tuple(sorted(set(consequent)))]
    j = counts[tuple(sorted(set(antecedent) | set(consequent)))]
    if (any(type(value) is not int for value in (n, a, b, j))
            or not 0 < j <= min(a, b) <= max(a, b) <= n
            or a + b - j > n or rule["ticketCount"] != j
            or not all(math.isclose(rule[name], expected, rel_tol=1e-12, abs_tol=1e-15)
                       for name, expected in (("support", j / n), ("confidence", j / a),
                                              ("lift", j * n / (a * b))))):
        raise ValueError("Invalid frozen association counts")
    return {**rule, "totalTickets": n, "antecedentCount": a,
            "consequentCount": b, "jointCount": j}
