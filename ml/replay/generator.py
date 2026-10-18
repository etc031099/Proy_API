"""Counter-keyed PRNG: one seed/profile, incremental append, no seed search."""
import hashlib
import random
from datetime import date, timedelta

from .policy import BASELINE_CLOSED, FINAL_CLOSED, GENERATOR_VERSION, LEVELS


class Generator:
    def __init__(self, source, seed, profile):
        if profile not in ("STABLE", "SHIFT") or isinstance(seed, bool) or not isinstance(seed, int):
            raise ValueError("REPLAY_GENERATOR_CONFIG_INVALID")
        self.seed, self.profile = seed, profile
        self.skus = sorted(source.product_by_sku)
        self.stats = {}
        for sku in self.skus:
            history = [source.inventory[sku][(BASELINE_CLOSED - timedelta(days=i)).isoformat()]["unitsSold"]
                       for i in range(56)]
            self.stats[sku] = (sum(history) / len(history), sum(x == 0 for x in history) / len(history))
        # Known existing item; +1 always adds exactly one sold unit.
        self.witness_sku = self.skus[self.rng("witness").randrange(len(self.skus))]

    def rng(self, key):
        raw = f"{GENERATOR_VERSION}:{self.seed}:{self.profile}:{key}".encode()
        return random.Random(int.from_bytes(hashlib.sha256(raw).digest(), "big"))

    def append(self, evidence, level):
        index = LEVELS.index(level)
        before = len(evidence["operations"])

        def sale(sku, day, quantity):
            evidence["operations"].append({"operationId": f"sale-{len(evidence['operations']) + 1:07d}",
                "sku": sku, "localDate": day.isoformat(), "quantity": quantity})

        if index < 3:
            for i in range((1, 7, 14)[index]):
                rng = self.rng(f"small:{index}:{i}")
                sale(self.witness_sku if index == 0 else rng.choice(self.skus), BASELINE_CLOSED,
                     1 if index == 0 else rng.randint(1, 3))
        else:
            start = date.fromisoformat(evidence["closedThrough"]) + timedelta(days=1)
            end = (FINAL_CLOSED if index == 6 else start + timedelta(days=(7, 14, 30)[index - 3] - 1))
            day = start
            while day <= end:
                evidence["completeDays"].append(day.isoformat())
                day_off = self.rng(f"day:{day}").random() < .035
                for sku_index, sku in enumerate(self.skus):
                    rng = self.rng(f"{day}:{sku}")
                    mean, zero = self.stats[sku]
                    if day_off or mean == 0 or rng.random() < min(.95, zero):
                        continue
                    age = (day - BASELINE_CLOSED).days
                    factor = (1.10 if day.weekday() >= 5 else .96) * (1 + min(age, 121) * .0004)
                    if self.profile == "SHIFT":
                        factor *= (1.4 if sku_index % 3 else .75) * (1 + age * .001)
                    quantity = max(1, round(mean / max(.05, 1 - zero) * factor * rng.uniform(.8, 1.2)))
                    sale(sku, day, quantity)
                day += timedelta(days=1)
            evidence["closedThrough"] = end.isoformat()
        return len(evidence["operations"]) - before
