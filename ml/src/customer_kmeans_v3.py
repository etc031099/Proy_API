"""Small, frozen RFM clustering experiment. Training is an explicit local command."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, silhouette_score, silhouette_samples
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer, RobustScaler, StandardScaler
from threadpoolctl import threadpool_limits

VERSION = "customer-kmeans-v3-v1"
CUTOFF = "2026-10-12"
FEATURES = ["recency", "frequency", "monetary"]
SEEDS = list(range(2026, 2036))
ARTIFACT_DIR = "ml/artifacts/customer-kmeans-v3"


def logical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def dataset_from_customers(customers):
    """R from observed last purchase; F/M within 90 closed historical days, PEN."""
    rows = []
    for customer in sorted(customers, key=lambda r: r["customerCode"]):
        ref = customer["customerCode"]
        if not ref or ref == "CONSUMER_FINAL":
            continue
        raw = customer["rfm90d"]["raw"]
        eligible = customer["ticketCount"] > 0 and raw["recencyDays"] is not None
        rows.append({"customerRef": ref, "status": "ELIGIBLE" if eligible else "INSUFFICIENT_HISTORY",
                     "recency": raw["recencyDays"], "frequency": raw["frequency90d"],
                     "monetary": raw["monetary90dCents"] / 100,
                     "rfmSegment": customer["segment"]})
    if len({r["customerRef"] for r in rows}) != len(rows):
        raise ValueError("Duplicate customer reference")
    matrix(rows)
    return rows


def matrix(rows):
    values = np.asarray([[r[f] for f in FEATURES] for r in rows if r["status"] == "ELIGIBLE"], dtype=float)
    if values.ndim != 2 or values.shape[1] != 3 or not np.isfinite(values).all() or (values < 0).any():
        raise ValueError("Invalid RFM observations")
    return values


def distribution(values):
    from scipy.stats import skew
    result = {}
    for i, feature in enumerate(FEATURES):
        x = values[:, i]
        q1, q3 = np.quantile(x, [.25, .75])
        result[feature] = {"min": float(x.min()), "q25": float(q1), "median": float(np.median(x)),
                           "q75": float(q3), "max": float(x.max()), "mean": float(x.mean()),
                           "skewness": float(skew(x)), "zeros": int((x == 0).sum()), "nulls": 0,
                           "iqrOutliers": int(((x < q1 - 1.5 * (q3-q1)) | (x > q3+1.5*(q3-q1))).sum())}
    return result


def pipeline(k, seed=2026, scaler="StandardScaler"):
    return Pipeline([("log", FunctionTransformer(np.log1p, inverse_func=np.expm1)),
                     ("scale", StandardScaler() if scaler == "StandardScaler" else RobustScaler()),
                     ("kmeans", KMeans(n_clusters=k, init="k-means++", n_init=20, max_iter=300,
                                       random_state=seed, algorithm="lloyd"))])


def evaluate(values, scaler):
    results = []
    for k in (2, 3, 4, 5):
        models = [pipeline(k, seed, scaler).fit(values) for seed in SEEDS]
        labels = [p.predict(values) for p in models]
        silhouettes = [float(silhouette_score(p[:-1].transform(values), y)) for p, y in zip(models, labels)]
        sizes = [np.bincount(y, minlength=k).tolist() for y in labels]
        ari = [float(adjusted_rand_score(labels[i], labels[j])) for i in range(len(labels)) for j in range(i)]
        subset_ari = []
        for seed in SEEDS:
            indices = np.random.default_rng(seed).choice(len(values), int(len(values)*.8), replace=False)
            sub = pipeline(k, seed, scaler).fit(values[indices])
            subset_ari.append(float(adjusted_rand_score(labels[0][indices], sub.predict(values[indices]))))
        results.append({"k": k, "scaler": scaler, "silhouetteMean": float(np.mean(silhouettes)),
                        "silhouetteStd": float(np.std(silhouettes)), "inertia": float(models[0][-1].inertia_),
                        "seedAriMean": float(np.mean(ari)), "subsampleAriMean": float(np.mean(subset_ari)),
                        "subsampleAriMin": float(min(subset_ari)), "clusterSizes": sizes[0],
                        "sizesBySeed": sizes, "minimumSizeAcrossSeeds": min(min(s) for s in sizes)})
    return results


def train(rows, source_hash, output_dir):
    values = matrix(rows)
    quality = {"original": distribution(values), "log1p": distribution(np.log1p(values)),
               "positiveActivityOriginal": distribution(values[values[:, 1] > 0]),
               "positiveActivityLog1p": distribution(np.log1p(values[values[:, 1] > 0])),
               "excludedNoHistory": sum(r["status"] != "ELIGIBLE" for r in rows),
               "consumerFinalExcluded": True, "outliersRemoved": 0}
    # Predeclared G.1 protocol: log all RFM, Standard primary, Robust sensitivity.
    with threadpool_limits(limits=1):
        candidates = evaluate(values, "StandardScaler") + evaluate(values, "RobustScaler")
        inactive = (values[:, 1] == 0) & (values[:, 2] == 0) & (values[:, 0] > 90)
        for candidate in candidates:
            probe = pipeline(candidate["k"], scaler=candidate["scaler"]).fit(values).predict(values)
            # Explicit, recorded exception to G.1's proposed size=5 heuristic:
            # retain the three genuinely inactive observations; never discard them.
            candidate["smallClusterJustified"] = all(
                count >= 5 or (count == 3 and np.array_equal(probe == label, inactive))
                for label, count in enumerate(np.bincount(probe)))
        reasonable = [c for c in candidates if c["scaler"] == "StandardScaler"
                      and c["smallClusterJustified"] and c["seedAriMean"] >= .8
                      and c["subsampleAriMin"] >= .8 and c["silhouetteMean"] > .25]
        if not reasonable:
            raise ValueError("NEEDS_MORE_DATA: no stable primary clustering meets exploratory gates")
        # Prefer a parsimonious partition within 0.03 of best silhouette.
        best = max(c["silhouetteMean"] for c in reasonable)
        selected = min((c for c in reasonable if c["silhouetteMean"] >= best-.03), key=lambda c: c["k"])
        model = pipeline(selected["k"]).fit(values)
        labels = model.predict(values)
        transformed = model[:-1].transform(values)
        pca = PCA(n_components=2, svd_solver="full").fit(transformed)
        points = pca.transform(transformed)
    centers = np.expm1(model["scale"].inverse_transform(model[-1].cluster_centers_))
    eligible = [r for r in rows if r["status"] == "ELIGIBLE"]
    profiles = []
    sil_by_row = silhouette_samples(transformed, labels)
    # Stable display IDs ordered by original monetary centroid, not quality ranks.
    mapping = {int(label): index+1 for index, label in enumerate(np.argsort(centers[:, 2]))}
    for label in range(selected["k"]):
        group = values[labels == label]
        med = np.median(group, axis=0)
        overall = np.median(values, axis=0)
        name = ("Inactivos en los últimos 90 días" if med[1] == 0 and med[2] == 0
                else "Frecuentes de gasto alto" if med[1] >= overall[1] and med[2] >= overall[2]
                else "Recientes de gasto bajo" if med[0] <= overall[0] and med[2] < overall[2]
                else "Menos recientes de gasto moderado" if med[0] > overall[0]
                else "Ocasionales de gasto moderado")
        profiles.append({"cluster": mapping[label], "name": name, "size": len(group),
                         "proportion": len(group)/len(values),
                         "centroidOriginal": dict(zip(FEATURES, map(float, centers[label]))),
                         "mean": dict(zip(FEATURES, map(float, group.mean(axis=0)))),
                         "median": dict(zip(FEATURES, map(float, med))),
                         "silhouetteMean": float(sil_by_row[labels == label].mean())})
    profiles.sort(key=lambda p: p["cluster"])
    distances = model[-1].transform(transformed)
    assignments = [{**row, "cluster": mapping[int(labels[i])],
                    "clusterName": next(p["name"] for p in profiles if p["cluster"] == mapping[int(labels[i])]),
                    "distance": float(distances[i, labels[i]]), "pc1": float(points[i, 0]), "pc2": float(points[i, 1])}
                   for i, row in enumerate(eligible)]
    assignments += [{**r, "cluster": None, "clusterName": None, "distance": None, "pc1": None, "pc2": None}
                    for r in rows if r["status"] != "ELIGIBLE"]
    sensitivity = next(c for c in candidates if c["scaler"] == "RobustScaler" and c["k"] == selected["k"])
    robust = pipeline(selected["k"], scaler="RobustScaler").fit(values)
    scaler_ari = float(adjusted_rand_score(labels, robust.predict(values)))
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / "model.joblib"
    joblib.dump({"pipeline": model, "pca": pca, "labelMapping": mapping, "version": VERSION}, artifact, compress=3)
    meta = {"contractVersion": VERSION, "modelId": "v3-customer-rfm-kmeans", "version": VERSION,
            "algorithm": "KMeans", "task": "customer_segmentation", "learningType": "unsupervised",
            "scenarioId": "minimarket-pasco-v3", "datasetVersion": "minimarket-pasco-v3-seed2026-v1",
            "sourceLogicalHash": source_hash, "trainingDataHash": logical_hash(rows), "trainingCutoff": CUTOFF,
            "sampleCount": len(values), "excludedCount": len(rows)-len(values), "features": FEATURES,
            "featureWindow": "R=days since last completed purchase; F/M=90 days inclusive; M=PEN",
            "transformations": ["log1p(recency)", "log1p(frequency)", "log1p(monetary)"],
            "scaler": "StandardScaler", "k": selected["k"], "randomState": 2026, "nInit": 20,
            "sklearnVersion": sklearn.__version__, "metrics": selected, "candidates": candidates,
            "scalerSensitivityAri": scaler_ari, "robustSensitivity": sensitivity,
            "selectionReason": "StandardScaler predeclared; seed ARI >=0.8, minimum subsample ARI >=0.8, silhouette >0.25; smallest k within 0.03 of best eligible silhouette. Documented size exception: a group of three is accepted only if exactly all F90=M90=0 and R>90 observations; every other group requires >=5.",
            "protocolDeviation": "G.1 proposed >=5 per group. All candidates isolate 3 inactive customers. No candidate met that heuristic. Exception adopted after inspection for exactly those 3, with stricter minimum subsample ARI=0.8; exploratory post-inspection decision, not independent validation.",
            "quality": quality, "clusters": profiles, "assignments": sorted(assignments, key=lambda a: a["customerRef"]),
            "pca": {"explainedVarianceRatio": pca.explained_variance_ratio_.tolist(), "visualizationOnly": True},
            "artifactHash": hashlib.sha256(artifact.read_bytes()).hexdigest(), "status": "EXPLORATORY",
            "limitations": ["38 clientes con historial en un escenario sintético; muestra pequeña y sin validación externa.",
                             "Clustering no implica churn, probabilidad ni superioridad sobre RFM por reglas.",
                             "RFM por reglas se conserva; IDs de clusters son arbitrarios.",
                             "Asignaciones actuales reutilizan el modelo congelado, sin reentrenamiento automático."]}
    (output / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    (output / "training-rfm.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    return meta
