import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium")


@app.cell
def _():
    import json
    import re

    import marimo as mo
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    from scipy import stats

    return json, mo, np, pd, plt, re, stats


@app.cell
def _(mo, re):
    ROOT = mo.notebook_dir().parent
    stages_ts = (ROOT / "shared" / "stages.ts").read_text()

    def ts_list(name):
        return re.findall(r"'([\w-]+)'", re.search(rf"{name} = \[(.*?)\]", stages_ts).group(1))

    STAGES = ts_list("MEASUREMENT_STAGES")
    STRATEGIES = ["full", "manifest"]
    LIVE_STRATEGIES = ts_list("STRATEGIES")
    HEARTBEAT_TICK_MS = int(
        re.search(r"HEARTBEAT_TICK_MS = (\d+)", (ROOT / "shared" / "heartbeat.ts").read_text()).group(1)
    )
    return HEARTBEAT_TICK_MS, LIVE_STRATEGIES, ROOT, STAGES, STRATEGIES


@app.cell
def _(ROOT, STAGES, STRATEGIES, pd):
    raw = pd.read_csv(ROOT / "data" / "results.csv")
    assert len(raw) == 240, f"expected 240 rows, got {len(raw)}"
    assert raw["error"].isna().all(), f"{raw['error'].notna().sum()} rows with error"
    runs = raw
    cell_sizes = runs.groupby(["strategy", "stage"]).size()
    assert set(runs["strategy"]) == set(STRATEGIES), set(runs["strategy"])
    assert set(runs["stage"]) == set(STAGES), set(runs["stage"])
    assert len(cell_sizes) == 8 and (cell_sizes == 30).all(), cell_sizes.to_dict()
    return (runs,)


@app.cell
def _(mo):
    mo.md("""
    # Size study, full and manifest

    ## Distribution per cell, `interruption_ms`
    """)
    return


@app.cell
def _(stats):
    def describe(values):
        return {
            "n": len(values),
            "median": values.median(),
            "mean": values.mean(),
            "min": values.min(),
            "max": values.max(),
            "q1": values.quantile(0.25),
            "q3": values.quantile(0.75),
            "iqr": values.quantile(0.75) - values.quantile(0.25),
            "skewness": stats.skew(values, bias=False),
            "shapiro_p": stats.shapiro(values).pvalue,
        }

    return (describe,)


@app.cell
def _(STAGES, STRATEGIES, describe, pd, runs):
    def cell_values(strategy, stage, column, data=runs):
        return data[(data["strategy"] == strategy) & (data["stage"] == stage)][column]

    def cell_table(column, data=runs, strategies=STRATEGIES, stages=STAGES):
        return pd.DataFrame(
            [
                {"strategy": strategy, "stage": stage, **describe(cell_values(strategy, stage, column, data))}
                for strategy in strategies
                for stage in stages
            ]
        )

    return cell_table, cell_values


@app.cell
def _(cell_table, mo):
    mo.ui.table(cell_table("interruption_ms"), selection=None, pagination=False)
    return


@app.cell
def _(STAGES, STRATEGIES, cell_values, plt, runs):
    def cell_grid(draw, figsize, data=runs, strategies=STRATEGIES, stages=STAGES, transpose=False):
        shape = (len(stages), len(strategies)) if transpose else (len(strategies), len(stages))
        fig, axes = plt.subplots(
            *shape, sharex="row" if transpose else "col", squeeze=False, figsize=figsize, layout="constrained"
        )
        for i, strategy in enumerate(strategies):
            for j, stage in enumerate(stages):
                row, col = (j, i) if transpose else (i, j)
                ax = axes[row, col]
                values = cell_values(strategy, stage, "interruption_ms", data)
                stage_values = data[data["stage"] == stage]["interruption_ms"]
                draw(ax, values, (stage_values.min(), stage_values.max()))
                if row == 0:
                    ax.set_title(strategy if transpose else stage)
                if col == 0:
                    ax.set_ylabel(stage if transpose else strategy)
        fig.supxlabel("interruption_ms")
        return fig

    return (cell_grid,)


@app.cell
def _(mo):
    mo.md("""
    ## Histograms, `interruption_ms`
    """)
    return


@app.cell
def _(cell_grid):
    def draw_hist(ax, values, value_range):
        ax.hist(values, bins=15, range=value_range)
        ax.axvline(values.median(), color="black", linestyle="--")
        ax.axvline(values.mean(), color="gray", linestyle=":")

    cell_grid(draw_hist, (12, 5))
    return (draw_hist,)


@app.cell
def _(mo):
    mo.md("""
    ## ECDF, `interruption_ms`
    """)
    return


@app.cell
def _(cell_grid):
    cell_grid(lambda ax, values, _range: ax.ecdf(values), (12, 5))
    return


@app.cell
def _(dispatch_gap, mo, pd, plt):
    def restore_summary(restore):
        restore_fig, restore_ax = plt.subplots(figsize=(6, 3))
        restore_ax.hist(restore, bins=range(int(restore.min() // 50 * 50), int(restore.max() // 50 * 50 + 100), 50))
        restore_ax.set_xlabel("restore_dispatch_ms")
        restore_ax.set_ylabel("runs")
        restore_counts = pd.DataFrame(
            [
                {
                    "n": len(restore),
                    "gap_low_ms": dispatch_gap[0],
                    "gap_high_ms": dispatch_gap[1],
                    "below_gap": int((restore <= dispatch_gap[0]).sum()),
                    "above_gap": int((restore >= dispatch_gap[1]).sum()),
                }
            ]
        )
        return mo.vstack([restore_fig, mo.ui.table(restore_counts, selection=None)])

    return (restore_summary,)


@app.cell
def _(mo):
    mo.md("""
    ## Restore dispatch, `restore_dispatch_ms`
    """)
    return


@app.cell
def _(restore_summary, runs):
    restore_summary(runs["restore_dispatch_ms"])
    return


@app.cell
def _(mo):
    mo.md("""
    ### Restore dispatch per cell
    """)
    return


@app.cell
def _(cell_table, mo):
    mo.ui.table(cell_table("restore_dispatch_ms"), selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Outlier, manifest/large
    """)
    return


@app.cell
def _(mo, pd, runs):
    outlier_cell = runs[(runs["strategy"] == "manifest") & (runs["stage"] == "large")]
    outlier = outlier_cell.loc[outlier_cell["interruption_ms"].idxmax()]
    header = pd.DataFrame(
        [outlier[["run_id", "position_in_cycle", "cycle", "first_run", "sanity_warnings", "host_stall_ms"]].to_dict()]
    )
    phases = [
        "kill_to_export_ms", "export_ms", "ingest_ms", "upload_ms", "boot_ms",
        "unpack_ms", "install_ms", "readstate_ms", "restart_ms", "alive_ms",
    ]
    aggregates = [c for c in runs.columns if c.startswith(("total_", "interruption_"))]
    dropped = [c for c in phases + aggregates if outlier_cell[c].isna().all()]

    def against_median(columns):
        kept = [c for c in columns if c not in dropped]
        table = pd.DataFrame(
            {"run": outlier[kept].astype(float), "cell_median": outlier_cell[kept].median()}
        )
        table["difference"] = table["run"] - table["cell_median"]
        return table.sort_values("difference", ascending=False).rename_axis("column").reset_index()

    mo.vstack(
        [
            mo.ui.table(header, selection=None),
            mo.ui.table(against_median(phases), selection=None, pagination=False),
            mo.ui.table(against_median(aggregates), selection=None, pagination=False),
            mo.md("No values in this cell: " + (", ".join(f"`{c}`" for c in dropped) or "none")),
        ]
    )
    return


@app.cell
def _(STAGES, cell_values, np, pd):
    DRAWS = 10_000
    SEED = 20261019

    def median_diff(a, b):
        return np.median(a, axis=-1) - np.median(b, axis=-1)

    def bootstrap_medians(a, rng):
        return np.median(a[rng.integers(0, len(a), (DRAWS, len(a)))], axis=-1)

    def bootstrap_diffs(a, b, rng):
        return bootstrap_medians(a, rng) - bootstrap_medians(b, rng)

    def permutation_p(a, b, rng):
        pooled = np.concatenate([a, b])
        shuffled = rng.permuted(np.tile(pooled, (DRAWS, 1)), axis=1)
        diffs = median_diff(shuffled[:, : len(a)], shuffled[:, len(a) :])
        return (np.sum(np.abs(diffs) >= abs(median_diff(a, b))) + 1) / (DRAWS + 1)

    rq2_rows, rq2_draws = [], {}
    for _stage, _rng in zip(STAGES, np.random.default_rng(SEED).spawn(len(STAGES))):
        _full = cell_values("full", _stage, "interruption_ms").to_numpy()
        _manifest = cell_values("manifest", _stage, "interruption_ms").to_numpy()
        rq2_draws[_stage] = bootstrap_diffs(_full, _manifest, _rng)
        _low, _high = np.percentile(rq2_draws[_stage], [2.5, 97.5])
        rq2_rows.append(
            {
                "stage": _stage,
                "median_diff_ms": median_diff(_full, _manifest),
                "ci_low": _low,
                "ci_high": _high,
                "ci_excludes_0": _low > 0 or _high < 0,
                "permutation_p": permutation_p(_full, _manifest, _rng),
                "payload_mb": cell_values("full", _stage, "payload_bytes").median() / 1e6,
            }
        )
    rq2 = pd.DataFrame(rq2_rows)
    rq2["bonferroni_p"] = (rq2["permutation_p"] * len(rq2)).clip(upper=1)
    return SEED, bootstrap_diffs, bootstrap_medians, median_diff, permutation_p, rq2, rq2_draws


@app.cell
def _(mo):
    mo.md("""
    ## RQ-2: full - manifest, `interruption_ms`
    """)
    return


@app.cell
def _(mo, np, pd, rq2, rq2_draws):
    _compared = rq2[rq2["stage"] != "small"]
    _sign_change = _compared.index[np.sign(_compared["median_diff_ms"]).diff().fillna(0) != 0]
    assert len(_sign_change) == 1, _compared[["stage", "median_diff_ms"]].to_dict("records")
    _before, _after = rq2.loc[_sign_change[0] - 1], rq2.loc[_sign_change[0]]

    def _crossing_mb(d0, d1):
        return _before["payload_mb"] - d0 * (_after["payload_mb"] - _before["payload_mb"]) / (d1 - d0)

    _crossing_low, _crossing_high = np.percentile(
        _crossing_mb(rq2_draws[_before["stage"]], rq2_draws[_after["stage"]]), [2.5, 97.5]
    )
    _crossing = pd.DataFrame(
        [
            {
                "between": f"{_before['stage']} - {_after['stage']}",
                "crossing_mb": _crossing_mb(_before["median_diff_ms"], _after["median_diff_ms"]),
                "ci_low_mb": _crossing_low,
                "ci_high_mb": _crossing_high,
            }
        ]
    )
    mo.vstack(
        [
            mo.ui.table(rq2, selection=None, pagination=False),
            mo.ui.table(_crossing, selection=None),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Run order, `interruption_ms`
    """)
    return


@app.cell
def _(STAGES, STRATEGIES, cell_values, mo, pd, runs):
    _order = pd.DataFrame(
        [
            {
                "strategy": _strategy,
                "stage": _stage,
                "median_all": cell_values(_strategy, _stage, "interruption_ms").median(),
                "median_without_first": cell_values(
                    _strategy, _stage, "interruption_ms", runs[~runs["first_run_of_cell"]]
                ).median(),
            }
            for _strategy in STRATEGIES
            for _stage in STAGES
        ]
    )
    _order["difference"] = _order["median_without_first"] - _order["median_all"]
    _position = runs.groupby("position_in_cycle")["interruption_ms"].agg(["size", "median"])
    _position["median_offset_from_cell"] = (
        (runs["interruption_ms"] - runs.groupby(["strategy", "stage"])["interruption_ms"].transform("median"))
        .groupby(runs["position_in_cycle"])
        .median()
    )
    _position = _position.reset_index()
    mo.vstack(
        [
            mo.ui.table(_order, selection=None, pagination=False),
            mo.ui.table(_position, selection=None, pagination=False),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## State loss, `state_loss_ticks`
    """)
    return


@app.cell
def _(cell_table, mo, pd, runs):
    _all_runs = pd.DataFrame([{"n": len(runs), "median": runs["state_loss_ticks"].median()}])
    mo.vstack(
        [
            mo.ui.table(cell_table("state_loss_ticks"), selection=None, pagination=False),
            mo.ui.table(_all_runs, selection=None),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Repeats, 95 % bootstrap CI width of the median `interruption_ms`
    """)
    return


@app.cell
def _(
    SEED,
    STAGES,
    STRATEGIES,
    bootstrap_medians,
    cell_values,
    mo,
    np,
    pd,
    runs,
):
    _ordered = runs.sort_values("cycle")
    _cells = [(_strategy, _stage) for _strategy in STRATEGIES for _stage in STAGES]
    _rows = []
    for (_strategy, _stage), _rng in zip(_cells, np.random.default_rng(SEED).spawn(len(_cells))):
        _values = cell_values(_strategy, _stage, "interruption_ms", _ordered).to_numpy()
        _row = {"strategy": _strategy, "stage": _stage}
        for _n in (10, 20, 30):
            _low, _high = np.percentile(bootstrap_medians(_values[:_n], _rng), [2.5, 97.5])
            _row[f"ci_width_{_n}"] = _high - _low
        _rows.append(_row)
    mo.ui.table(pd.DataFrame(_rows), selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Negative `restore_dispatch_ms`
    """)
    return


@app.cell
def _(mo, runs):
    _negative = runs[runs["restore_dispatch_ms"] < 0]
    _rtt_median = runs.groupby(["strategy", "stage"])["target_clock_rtt_ms"].median().rename("cell_median_rtt_ms")
    _negative = _negative.join(_rtt_median, on=["strategy", "stage"])[
        ["run_id", "restore_dispatch_ms", "target_clock_offset_ms", "target_clock_rtt_ms", "cell_median_rtt_ms"]
    ]
    mo.ui.table(_negative, selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Payload per strategy, `payload_bytes`
    """)
    return


@app.cell
def _(mo, runs):
    _payload = runs.groupby("strategy")["payload_bytes"].agg(["size", "min", "median", "max"]).reset_index()
    mo.ui.table(_payload, selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    # Live study, stage large
    """)
    return


@app.cell
def _(LIVE_STRATEGIES, ROOT, pd):
    live_runs = pd.read_csv(ROOT / "data" / "live" / "results.csv")
    assert len(live_runs) == 120, f"expected 120 rows, got {len(live_runs)}"
    assert live_runs["error"].isna().all(), f"{live_runs['error'].notna().sum()} rows with error"
    assert set(live_runs["session_label"]) == {"live-study"}, set(live_runs["session_label"])
    assert set(live_runs["stage"]) == {"large"}, set(live_runs["stage"])
    assert set(live_runs["strategy"]) == set(LIVE_STRATEGIES), set(live_runs["strategy"])
    live_sizes = live_runs.groupby(["strategy", "stage"]).size()
    assert len(live_sizes) == 4 and (live_sizes == 30).all(), live_sizes.to_dict()
    return (live_runs,)


@app.cell
def _(mo):
    mo.md("""
    ## Distribution per strategy, `interruption_ms`
    """)
    return


@app.cell
def _(LIVE_STRATEGIES, cell_table, live_runs, mo):
    mo.ui.table(
        cell_table("interruption_ms", live_runs, LIVE_STRATEGIES, ["large"]), selection=None, pagination=False
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Histograms and ECDF, `interruption_ms`
    """)
    return


@app.cell
def _(LIVE_STRATEGIES, cell_grid, draw_hist, live_runs):
    cell_grid(draw_hist, (12, 2.5), live_runs, LIVE_STRATEGIES, ["large"], transpose=True)
    return


@app.cell
def _(LIVE_STRATEGIES, cell_grid, live_runs):
    cell_grid(lambda ax, values, _range: ax.ecdf(values), (12, 2.5), live_runs, LIVE_STRATEGIES, ["large"], transpose=True)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Restore dispatch, `restore_dispatch_ms`
    """)
    return


@app.cell
def _(live_runs, restore_summary):
    restore_summary(live_runs["restore_dispatch_ms"])
    return


@app.cell
def _(live_runs, np):
    PUSH_STRATEGIES = ["precopy", "manifest-push"]
    _push = live_runs["strategy"].isin(PUSH_STRATEGIES)
    assert live_runs.loc[_push, ["prepare_ms", "prepare_to_stop_ms"]].notna().all(axis=None)
    live_times = live_runs.assign(
        total_migration_ms=np.where(
            _push, live_runs["prepare_ms"] + live_runs["interruption_ms"], live_runs["interruption_ms"]
        )
    )
    live_times["total_with_wait_ms"] = live_times["total_migration_ms"] + np.where(
        _push, live_times["prepare_to_stop_ms"], 0
    )
    return PUSH_STRATEGIES, live_times


@app.cell
def _(mo):
    mo.md("""
    ## Total migration time and its parts
    """)
    return


@app.cell
def _(LIVE_STRATEGIES, PUSH_STRATEGIES, cell_table, live_times, mo):
    _parts = []
    for _column, _strategies in [
        ("total_migration_ms", LIVE_STRATEGIES),
        ("total_with_wait_ms", LIVE_STRATEGIES),
        ("prepare_ms", PUSH_STRATEGIES),
        ("prepare_to_stop_ms", PUSH_STRATEGIES),
    ]:
        _table = cell_table(_column, live_times, _strategies, ["large"])
        _parts += [mo.md(f"`{_column}`"), mo.ui.table(_table, selection=None, pagination=False)]
    mo.vstack(_parts)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Medians per strategy
    """)
    return


@app.cell
def _(LIVE_STRATEGIES, live_runs, mo):
    _columns = ["payload_bytes", "boot_ms", "install_ms", "restart_ms"]
    _medians = live_runs.groupby("strategy")[_columns].median().loc[LIVE_STRATEGIES].reset_index()
    mo.ui.table(_medians, selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Comparisons, a - b
    """)
    return


@app.cell
def _(
    SEED,
    bootstrap_diffs,
    cell_values,
    live_times,
    median_diff,
    mo,
    np,
    pd,
    permutation_p,
):
    _comparisons = [
        ("precopy", "full", "interruption_ms"),
        ("manifest-push", "manifest", "interruption_ms"),
        ("precopy", "manifest-push", "interruption_ms"),
        ("precopy", "manifest-push", "total_migration_ms"),
        ("precopy", "manifest-push", "total_with_wait_ms"),
        ("precopy", "full", "total_migration_ms"),
        ("precopy", "full", "total_with_wait_ms"),
        ("manifest-push", "full", "total_migration_ms"),
        ("manifest-push", "full", "total_with_wait_ms"),
    ]
    _rows = []
    for (_a, _b, _column), _rng in zip(_comparisons, np.random.default_rng(SEED).spawn(len(_comparisons))):
        _first = cell_values(_a, "large", _column, live_times).to_numpy()
        _second = cell_values(_b, "large", _column, live_times).to_numpy()
        _low, _high = np.percentile(bootstrap_diffs(_first, _second, _rng), [2.5, 97.5])
        _rows.append(
            {
                "a": _a,
                "b": _b,
                "column": _column,
                "median_diff_ms": median_diff(_first, _second),
                "ci_low": _low,
                "ci_high": _high,
                "ci_excludes_0": _low > 0 or _high < 0,
                "permutation_p": permutation_p(_first, _second, _rng),
            }
        )
    mo.ui.table(pd.DataFrame(_rows), selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Size study - live study, stage large, `interruption_ms`

    Both sessions run full and manifest at large. If the interval includes 0, the two sessions can't be told apart, but it also doesn't show that they are the same.
    """)
    return


@app.cell
def _(SEED, STRATEGIES, bootstrap_diffs, cell_values, live_runs, median_diff, mo, np, pd):
    _rows = []
    for _strategy, _rng in zip(STRATEGIES, np.random.default_rng(SEED).spawn(len(STRATEGIES))):
        _size = cell_values(_strategy, "large", "interruption_ms").to_numpy()
        _live = cell_values(_strategy, "large", "interruption_ms", live_runs).to_numpy()
        _low, _high = np.percentile(bootstrap_diffs(_size, _live, _rng), [2.5, 97.5])
        _rows.append(
            {
                "strategy": _strategy,
                "median_size_ms": np.median(_size),
                "median_live_ms": np.median(_live),
                "median_diff_ms": median_diff(_size, _live),
                "ci_low": _low,
                "ci_high": _high,
                "ci_width": _high - _low,
                "ci_excludes_0": _low > 0 or _high < 0,
            }
        )
    mo.ui.table(pd.DataFrame(_rows), selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Source shortfall during the push phase
    """)
    return


@app.cell
def _(HEARTBEAT_TICK_MS, PUSH_STRATEGIES, cell_values, live_runs, mo, pd, stats):
    _nominal_ticks_per_s = 1000 / HEARTBEAT_TICK_MS
    _fit = stats.linregress(live_runs["stop_offset_actual_ms"], live_runs["state_loss_ticks"])
    _idle_ticks_per_s = _fit.slope * 1000
    _idle_rate = pd.DataFrame(
        [
            {
                "n": len(live_runs),
                "idle_ticks_per_s": _idle_ticks_per_s,
                "intercept_ticks": _fit.intercept,
                "r2": _fit.rvalue**2,
                "below_nominal_pct": (1 - _idle_ticks_per_s / _nominal_ticks_per_s) * 100,
            }
        ]
    )
    _rows = []
    for _strategy in PUSH_STRATEGIES:
        _source = cell_values(_strategy, "large", "push_source_ticks", live_runs)
        _expected = cell_values(_strategy, "large", "push_expected_ticks", live_runs)
        _against_idle = (1 - (_source / _expected) * _nominal_ticks_per_s / _idle_ticks_per_s) * 100
        _against_nominal = (1 - _source / _expected) * 100
        _rows.append(
            {
                "strategy": _strategy,
                "n": len(_source),
                "against_idle_median_pct": _against_idle.median(),
                "against_idle_min_pct": _against_idle.min(),
                "against_idle_max_pct": _against_idle.max(),
                "against_idle_max_abs_pct": _against_idle.abs().max(),
                "against_nominal_median_pct": _against_nominal.median(),
                "against_nominal_min_pct": _against_nominal.min(),
                "against_nominal_max_pct": _against_nominal.max(),
            }
        )
    mo.vstack(
        [
            mo.ui.table(_idle_rate, selection=None),
            mo.ui.table(pd.DataFrame(_rows), selection=None, pagination=False),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Delta at the stop, push strategies
    """)
    return


@app.cell
def _(PUSH_STRATEGIES, live_runs, mo):
    _push = live_runs[live_runs["strategy"].isin(PUSH_STRATEGIES)]
    _delta = _push.groupby("delta_files")["delta_bytes"].agg(["size", "min", "median", "max"]).reset_index()
    mo.ui.table(_delta, selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    # Phases, size study

    Means per cell, blank phases count as 0.
    """)
    return


@app.cell
def _(STAGES, STRATEGIES, pd, runs):
    _columns = [
        "export_ms", "upload_ms", "unpack_ms", "install_ms", "boot_ms", "restart_ms", "alive_to_tick_ms",
        "ingest_ms", "adapter_overhead_ms", "readstate_ms", "total_wall_to_tick_ms",
    ]
    _means = runs[["strategy", "stage", *_columns]].fillna(0).groupby(["strategy", "stage"]).mean()
    cell_order = pd.MultiIndex.from_product([STRATEGIES, STAGES], names=["strategy", "stage"])
    phase_means = pd.DataFrame(
        {
            "transfer": _means["export_ms"] + _means["upload_ms"] + _means["unpack_ms"],
            "install": _means["install_ms"],
            "target_start": _means["boot_ms"] + _means["restart_ms"] + _means["alive_to_tick_ms"],
            "harness": _means["ingest_ms"] + _means["adapter_overhead_ms"] + _means["readstate_ms"],
            "total": _means["export_ms"] + _means["total_wall_to_tick_ms"],
        }
    ).reindex(cell_order)
    phase_means["unaccounted"] = phase_means["total"] - phase_means[
        ["transfer", "install", "target_start", "harness"]
    ].sum(axis=1)
    return cell_order, phase_means


@app.cell
def _(ROOT, STAGES, STRATEGIES, phase_means, runs):
    _figures = ROOT / "paper" / "figures"
    _project_bytes = runs[runs["strategy"] == "full"].groupby("stage")["payload_bytes"].median()
    _payload_bytes = runs.groupby(["strategy", "stage"])["payload_bytes"].median()

    def _size_label(n):
        return f"{n / 1e3:.1f} kB" if n < 1e5 else f"{n / 1e6:.2f} MB"

    def _exact(v):
        return str(round(float(v), 3)).removesuffix(".0")

    _dat = ["y transfer install targetstart harness total unacc n label"]
    _csv = [
        "strategy;stage;project_bytes;payload_bytes;n;transfer_ms;install_ms;target_start_ms;harness_ms;"
        "unaccounted_ms;total_ms;interruption_median_ms;interruption_min_ms;interruption_max_ms;"
        "interruption_q1_ms;interruption_q3_ms;interruption_iqr_ms"
    ]
    for _i, _stage in enumerate(STAGES):
        for _j, _strategy in enumerate(STRATEGIES):
            _p = phase_means.loc[(_strategy, _stage)]
            _phases = [_p["transfer"], _p["install"], _p["target_start"], _p["harness"]]
            _interruption = runs[(runs["strategy"] == _strategy) & (runs["stage"] == _stage)]["interruption_ms"]
            assert _interruption.notna().all(), f"{_strategy}/{_stage}: interruption_ms missing"
            _q1, _median, _q3 = _interruption.quantile([0.25, 0.5, 0.75])
            _dat.append(
                " ".join(
                    [
                        f"{round(_i * (len(STRATEGIES) + 0.4) + _j + 1, 1):g}",
                        *(f"{_v:.1f}" for _v in [*_phases, _p["total"], _p["unaccounted"]]),
                        str(len(_interruption)),
                        f"{{{_strategy} / {_stage}, {_size_label(_project_bytes[_stage])}}}",
                    ]
                )
            )
            _csv.append(
                ";".join(
                    [
                        _strategy,
                        _stage,
                        str(round(_project_bytes[_stage])),
                        str(round(_payload_bytes[(_strategy, _stage)])),
                        str(len(_interruption)),
                        *(str(round(_v)) for _v in [*_phases, _p["unaccounted"], _p["total"]]),
                        *map(_exact, [_median, _interruption.min(), _interruption.max(), _q1, _q3, _q3 - _q1]),
                    ]
                )
            )
    (_figures / "decomposition.dat").write_text("\n".join(_dat) + "\n")
    (_figures / "decomposition.csv").write_text("\r\n".join(_csv) + "\r\n", newline="")
    return


@app.cell
def _(STAGES, mo, pd, phase_means):
    _full, _manifest = phase_means.loc["full"], phase_means.loc["manifest"]
    _saved = pd.DataFrame(
        {
            "saved_transfer": _full["transfer"] - _manifest["transfer"],
            "saved_target_start": _full["target_start"] - _manifest["target_start"],
        }
    ).loc[STAGES]
    mo.vstack(
        [
            mo.ui.table(phase_means.reset_index(), selection=None, pagination=False),
            mo.md(f"Largest absolute unaccounted time over the cell means: {phase_means['unaccounted'].abs().max():.1f} ms."),
            mo.md("Full - manifest"),
            mo.ui.table(_saved.reset_index(), selection=None, pagination=False),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Client share of the interruption, medians
    """)
    return


@app.cell
def _(cell_order, mo, runs):
    _medians = (
        runs.assign(client_ms=runs["kill_to_export_ms"] + runs["export_ms"])
        .groupby(["strategy", "stage"])[["export_ms", "client_ms", "interruption_ms"]]
        .median()
        .reindex(cell_order)
    )
    _medians["client_share_pct"] = _medians["client_ms"] / _medians["interruption_ms"] * 100
    mo.ui.table(_medians.reset_index(), selection=None, pagination=False)
    return


@app.cell
def _(mo):
    mo.md("""
    # Uplink, size study, full

    Straight line (OLS) of `upload_ms` over `payload_bytes`. The second table shows the crossing point at half, the measured and double the uplink.
    """)
    return


@app.cell
def _(mo, np, pd, rq2, runs, stats):
    _full = runs[runs["strategy"] == "full"]
    _fit = stats.linregress(_full["payload_bytes"] / 1e6, _full["upload_ms"])
    _uplink = pd.DataFrame(
        [
            {
                "n": len(_full),
                "slope_ms_per_mb": _fit.slope,
                "intercept_ms": _fit.intercept,
                "r2": _fit.rvalue**2,
                "uplink_mb_per_s": 1000 / _fit.slope,
            }
        ]
    )
    _compared = rq2[rq2["stage"] != "small"]
    _payload = _compared["payload_mb"].to_numpy()
    _rows = []
    for _factor in (0.5, 1, 2):
        _diff = _compared["median_diff_ms"].to_numpy() + (_factor - 1) * _fit.slope * _payload
        _rising = np.flatnonzero((_diff[:-1] < 0) & (_diff[1:] >= 0))
        assert len(_rising) == 1, _diff
        _i = _rising[0]
        _rows.append(
            {
                "uplink_speed_factor": 1 / _factor,
                "uplink_mb_per_s": 1000 / (_fit.slope * _factor),
                "crossing_mb": _payload[_i] - _diff[_i] * (_payload[_i + 1] - _payload[_i]) / (_diff[_i + 1] - _diff[_i]),
            }
        )
    mo.vstack(
        [
            mo.ui.table(_uplink, selection=None),
            mo.ui.table(pd.DataFrame(_rows), selection=None, pagination=False),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    # Crossing point from the phases, size study

    Straight line (OLS) of the transfer of full over `payload_bytes`. The other phases are medians, the install per stage.
    """)
    return


@app.cell
def _(STAGES, mo, pd, runs, stats):
    _phases = runs.assign(
        transfer_ms=runs["export_ms"] + runs["upload_ms"] + runs["unpack_ms"],
        target_start_ms=runs["boot_ms"] + runs["restart_ms"] + runs["alive_to_tick_ms"],
    )
    _full = _phases[_phases["strategy"] == "full"]
    _manifest = _phases[(_phases["strategy"] == "manifest") & _phases["install_ms"].notna()]
    _fit = stats.linregress(_full["payload_bytes"] / 1e6, _full["transfer_ms"])
    _install = _manifest.groupby("stage")["install_ms"].median().reindex(STAGES).dropna()
    _constant = _manifest["transfer_ms"].median() + _manifest["target_start_ms"].median()
    _from_phases = pd.DataFrame(
        {
            "install_ms": _install,
            "crossing_mb": (_constant + _install - _full["target_start_ms"].median() - _fit.intercept) / _fit.slope,
        }
    )
    mo.ui.table(_from_phases.reset_index(), selection=None, pagination=False)
    return


@app.cell
def _(live_runs, pd, runs):
    both_studies = pd.concat([runs.assign(study="size"), live_runs.assign(study="live")], ignore_index=True)
    return (both_studies,)


@app.cell
def _(both_studies, np):
    _dispatch = both_studies["restore_dispatch_ms"]
    assert _dispatch.notna().all(), f"{_dispatch.isna().sum()} runs without restore_dispatch_ms"
    _sorted = np.sort(_dispatch.to_numpy())
    _i = int(np.argmax(np.diff(_sorted)))
    dispatch_gap = (_sorted[_i], _sorted[_i + 1])
    # the largest gap has to split the runs into two groups, not cut off a tail
    assert min(_i + 1, len(_sorted) - _i - 1) >= 0.2 * len(_sorted), dispatch_gap
    return (dispatch_gap,)


@app.cell
def _(mo):
    mo.md("""
    # Clocks, both studies
    """)
    return


@app.cell
def _(both_studies, mo, pd):
    _rtt = both_studies["target_clock_rtt_ms"]
    _cell_rtt = both_studies.groupby(["study", "strategy", "stage"])["target_clock_rtt_ms"].median()
    _clocks = pd.DataFrame(
        [
            {
                "runs": len(both_studies),
                "client_skew_min_ms": both_studies["client_clock_skew_ms"].min(),
                "client_skew_max_ms": both_studies["client_clock_skew_ms"].max(),
                "cells": len(_cell_rtt),
                "cell_median_rtt_min_ms": _cell_rtt.min(),
                "cell_median_rtt_max_ms": _cell_rtt.max(),
                "max_half_rtt_ms": _rtt.max() / 2,
                "max_rtt_ms": _rtt.max(),
            }
        ]
    )
    mo.ui.table(_clocks, selection=None)
    return


@app.cell
def _(mo):
    mo.md("""
    # Restore dispatch per cell, both studies
    """)
    return


@app.cell
def _(both_studies, dispatch_gap, mo):
    _dispatch = both_studies["restore_dispatch_ms"]
    _low, _high = dispatch_gap
    _counts = (
        both_studies[["study", "strategy", "stage"]]
        .assign(below_gap=_dispatch <= _low, above_gap=_dispatch >= _high)
        .groupby(["study", "strategy", "stage"])
        .sum()
    )
    assert (_counts > 0).all(axis=None), _counts.to_dict("index")
    _below, _above = _counts["below_gap"], _counts["above_gap"]
    mo.vstack(
        [
            mo.md(
                f"No run between {_low:g} and {_high:g} ms. Per cell, {_below.min()} to {_below.max()} runs lie below"
                f" the gap and {_above.min()} to {_above.max()} above it."
            ),
            mo.ui.table(_counts.reset_index(), selection=None, pagination=False),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    # Correct handovers, both studies
    """)
    return


@app.cell
def _(both_studies, mo, pd):
    _correct = (
        both_studies["heartbeat_resumed"]
        & both_studies["state_restored"]
        & both_studies["resume_verified"]
        & (both_studies["counter_expected"] == both_studies["counter_actual"])
    )
    assert _correct.all(), both_studies.loc[~_correct, "run_id"].tolist()
    mo.ui.table(pd.DataFrame([{"runs": len(both_studies), "correct": int(_correct.sum())}]), selection=None)
    return


@app.cell
def _(mo):
    mo.md("""
    # Packages per stage, lockfiles
    """)
    return


@app.cell
def _(ROOT, STAGES, json, mo, pd):
    _rows = []
    for _stage in STAGES:
        _path = ROOT / "browser" / "src" / "lockfiles" / f"{_stage}.json"
        # a stage without a lockfile has no dependencies
        _packages = json.loads(_path.read_text())["packages"] if _path.exists() else {}
        _rows.append({"stage": _stage, "lockfile": _path.exists(), "packages": len([_n for _n in _packages if _n])})
    mo.ui.table(pd.DataFrame(_rows), selection=None, pagination=False)
    return


if __name__ == "__main__":
    app.run()
