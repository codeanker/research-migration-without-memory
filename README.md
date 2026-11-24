# research-migration-without-memory

MRP1 research project at HAW Kiel in cooperation with CODEANKER GmbH in Flensburg. The paper is submitted to IARIA CLOUD COMPUTING 2027 by the 24th of November 2026.

## Contents

- [Research questions](#research-questions)
- [Architecture](#architecture)
- [Setup](#setup)
- [Running](#running)
- [Analysis](#analysis)
- [Limits of the measurement](#limits-of-the-measurement)
- [Team](#team)
- [Use of Generative AI](#use-of-generative-ai)
- [License](#license)

## Research questions

The research questions are defined in [`paper/sections/03-research-questions.tex`](paper/sections/03-research-questions.tex) and are listed here in the same wording.

- **RQ-1**: Which of the established migration strategies have a counterpart at the filesystem level across an isolation boundary that shares no memory image?
- **RQ-2**: From which project size on does manifest-based transfer beat the full copy (cold migration) at a session handover across such a boundary?

RQ-1 is derived from the literature, and RQ-2 is answered by measurement.

The design has 2 strategies and 4 payload stages at 30 repetitions, which makes 8 cells and 240 runs. The strategies are cold migration (CSV value `full`) and manifest-based transfer (`manifest`). The sizes of the stages are reported in the paper.

| stage | dependency |
|---|---|
| small | none |
| light | `express` |
| medium | `@babel/preset-env` |
| large | `aws-sdk` |

[`data/archive/2026-09-28/`](data/archive/2026-09-28/) holds 90 runs of cold migration from an earlier session with an older version of the code. They are not part of the results and are never combined with new runs.

Both strategies are implemented at all four stages, and the browser installs every stage that has dependencies with `npm ci` against a lockfile in [`browser/src/lockfiles/`](browser/src/lockfiles/). The strategy `manifest` exports `work/` without `node_modules`, and afterwards the target runs `npm ci --no-audit --no-fund` between the unpack and the restart. This happens inside the interruption and is measured as `install_ms`.

The live study ([`experiments/live-study.json`](experiments/live-study.json)) measures pre-copy at the file level at the stage large, with 4 strategies at 30 repetitions in one session. The strategies `precopy` and `manifest-push` prepare the target before the stop, so at the stop only the files written since the push are being sent. The push phase is in the `push_*` and `prepare_*` columns, and for these rows `boot_ms` and `install_ms` stay blank.

## Architecture

The whole project is written in TypeScript, as CODEANKER works with it. Node runs the `.ts` files with type stripping, and Vite bundles the browser side. That is why the files that Node runs import with the real extensions ([`./plan.ts`](runner/plan.ts)) and `import type`.

- [`browser/`](browser/) is the Vite app with `@webcontainer/api`, which runs the WebContainer in the browser. A single measurement run is in [`src/experiment.ts`](browser/src/experiment.ts), and the form and `window.__handover` are in [`src/main.ts`](browser/src/main.ts).
- [`runner/`](runner/) is the local Node server, which takes the export, calls a target through [`targets/shell-adapter.ts`](targets/shell-adapter.ts) and writes [`results.csv`](data/results.csv) and [`env.json`](data/env.json) into the data directory of the session. [`experiment.ts`](runner/experiment.ts) runs a whole session, [`plan.ts`](runner/plan.ts) builds the plan and [`timing.ts`](runner/timing.ts) holds the calculations and the sanity checks.
- [`targets/`](targets/) has one adapter per target, and everything that is measured after the creation of the target is in [`shell-adapter.ts`](targets/shell-adapter.ts). [`e2b.ts`](targets/e2b.ts) and [`local.ts`](targets/local.ts) define how a target is created and destroyed, how a command runs and how a file is moved, and they measure `boot_ms`. `local.ts` sets the clock offset to 0.
- [`shared/`](shared/) holds what both sides need, meaning the format of the heartbeat line, the headers of `POST /run`, the stages, the push helpers, the JSON files in `work/` and the contract of `window.__handover`.
- [`experiments/`](experiments/) holds the versioned session configurations, and [`test/`](test/) holds the tests for `node --test`.
- [`analysis/`](analysis/) holds the marimo notebook [`distribution.py`](analysis/distribution.py), which computes all measured numbers of the paper and the data of the bar chart from [`data/`](data/).

## Setup

Node 24 or newer (tested with v26.5.0), pnpm 12.14.0, `zip` and `unzip` are needed. The analysis also needs uv, and the paper needs TeX Live with `latexmk` and `biber`. The dev container in [`.devcontainer/`](.devcontainer/) installs all of them.

```bash
pnpm install
pnpm exec playwright install --with-deps chromium
cp .env.example .env
```

Playwright drives a headless Chromium, so one script runs the whole session without manual intervention and the runs stay comparable. Chromium is used, because WebContainers are fully supported in Chromium-based browsers and only in beta in Safari and Firefox ([WebContainers, Browser support](https://webcontainers.io/guides/browser-support), accessed 2026-11-24). Furthermore, WebContainers need `SharedArrayBuffer` and therefore cross-origin isolation ([WebContainers, Configuring headers](https://webcontainers.io/guides/configuring-headers), accessed 2026-11-24). The `E2B_API_KEY` comes from an E2B account and is only needed for real runs.

## Running

1. First, the setup is checked without an API key, and the smoke test checks the runner end to end against `local`. It writes to `data/smoke-*` and never into the measurement data. Git ignores these files, since the runs only check the setup on the local machine and are not part of the results.

   ```bash
   pnpm test
   pnpm typecheck
   pnpm run smoke
   ```

2. Second, `--dry-run` prints the plan and the data paths of a study without measuring anything.

   ```bash
   pnpm run experiment --dry-run        # size study, experiments/main-study.json
   pnpm run experiment:live --dry-run   # live study, experiments/live-study.json
   ```

3. Lastly, a study is run with its own data directory, which is set by `DATA_DIR`.

   ```bash
   DATA_DIR=data/rerun pnpm run experiment             # size study, 240 runs
   DATA_DIR=data/rerun-live pnpm run experiment:live   # live study, 120 runs
   ```

A new data directory is needed, since the runner appends to an existing `results.csv` and stops if its header differs, which is the case for [`data/results.csv`](data/results.csv). Before the first run, the smoke test is carried out against `local`. Afterwards, [`runner/experiment.ts`](runner/experiment.ts) starts the runner, Vite and a headless Chromium by itself and writes a session manifest to `sessions/` in the data directory. For the size study, the manifest of the reported session is in [`data/sessions/`](data/sessions/), and for the live study, it is in [`data/live/sessions/`](data/live/sessions/). `CSV_PATH` and `ENV_PATH` override single files, and all flags are in [`parseArgs`](runner/experiment.ts#L411) in [`runner/experiment.ts`](runner/experiment.ts).

Single runs are started with `TARGET=e2b node runner/server.ts` and `pnpm run browser`, and then the form at the Vite URL is used. This is only a debug view, which logs no seed and no order.

The lockfiles are resolved as of the 28th of September 2026, so a later install gets the same package versions and new runs stay comparable. To create a lockfile again, this command is run in a directory with the `package.json` of the stage:

```bash
npm install --package-lock-only --before=2026-09-28T19:50:00Z
```

## Analysis

The analysis reads the data of the paper in [`data/`](data/). The size study was the first study and lies directly in `data/`, and the live study lies in `data/live/`, so the data of both never mixes. The reported data was measured with the code at these tags. The branch `main` is a later refactoring with the same study plans.

| Study | Tag | Session manifest |
|---|---|---|
| Size study | `size-study` | [`data/sessions/main-study-2026-10-13T17-27-19-307Z.json`](data/sessions/main-study-2026-10-13T17-27-19-307Z.json) |
| Live study | `live-study` | [`data/live/sessions/live-study-2026-10-19T13-55-44-750Z.json`](data/live/sessions/live-study-2026-10-19T13-55-44-750Z.json) |

The field `git.commit` in the session manifests holds the hash of the same code in the original repository.

Between the two tags, the push strategies were added for the live study, with the columns `push_*`, `prepare_*`, `delta_*`, `push_source_ticks` and `push_expected_ticks`. Therefore, a new run of the size study with `main` writes 69 columns instead of the 57 in `data/results.csv`, and the new columns stay blank for the strategies `full` and `manifest`.

The refactored code was checked on the 8th of November 2026 with 120 runs, 10 per cell of both studies. The data is in [`data/refactoring-check/`](data/refactoring-check/), and the paper does not use it. No run has an error, and the same measurement columns are filled as in the data of the studies. At the stages light, medium and large, the strategies stay in the same order. In all 12 cells, the median of `interruption_ms` is lower than in the studies. Compared to the spread of the runs in the size study, the strategy `full` at the stage medium differs the most. Therefore, this cell also ran with the code at the tag `size-study`, where its median is also lower, so the old code shows the same shift. With 10 instead of 30 repetitions, this check only rules out large changes.

The notebook [`analysis/distribution.py`](analysis/distribution.py) is the only source of the measured numbers in the paper. It writes [`paper/figures/decomposition.dat`](paper/figures/decomposition.dat) for the bar chart of the phases ([`figures/decomposition.tex`](paper/figures/decomposition.tex)) and [`paper/figures/decomposition.csv`](paper/figures/decomposition.csv) with the numbers of this figure and the spread of `interruption_ms` per cell, separated by `;`. `make` in [`paper/`](paper/) runs the notebook through `uv` when the data or the notebook has changed, and without [`data/results.csv`](data/results.csv) it skips the bar chart. It also builds the setup diagram [`paper/figures/setup-diagram.pdf`](paper/figures/setup-diagram.pdf) from [`figures/setup-diagram.tex`](paper/figures/setup-diagram.tex), which needs no data.

The analysis runs in a marimo notebook on the system Python (3.13 or newer) through `uv`:

```bash
uv sync
uv run marimo edit analysis/distribution.py
uv run python analysis/distribution.py
uv run marimo export html analysis/distribution.py -o distribution.html
make -C paper        # build the figures and the paper
make -C paper fresh  # build everything again from scratch
```

Each run of the notebook writes `paper/figures/decomposition.dat` and `paper/figures/decomposition.csv`, from any working directory.

## Limits of the measurement

The threats to validity are discussed in the paper. This section lists the information needed for a new run or for reading the data.

- E2B creates the targets in us-west-1, the default region. The measurements ran on the free plan of E2B, where no other region was available, since other regions have to be enabled by the support of E2B first ([E2B Docs, SDK client](https://docs.e2b.dev/client), [E2B Docs, Can I run sandboxes in the EU?](https://docs.e2b.dev/faq/eu-region), both accessed 2026-11-16). The uplink of the client from Kiel crosses the Atlantic. Therefore, all times only hold for this link.
- `install_ms` depends on the npm of the target. E2B runs npm 10.1.0, which was read manually on the 13th of October 2026, since [`data/env.json`](data/env.json) only records the Node version.
- Source and target run different Node versions on purpose. The source runs v26.5.0 from the dev container, and the target runs v20.9.0 from the default template of E2B, as read when the target is created. Another version on the target would need a custom template ([E2B Docs, Base image](https://docs.e2b.dev/template/base-image), accessed 2026-11-24), and the measurement uses the default template. `node_version_aligned` in `data/env.json` records this as `false`.
- On `local`, `npm ci` uses the warm npm cache of the host, so the local `install_ms` is only a lower bound.
- `push_expected_ticks` counts 10 ticks/s, but the idle source runs slower. Therefore, the idle reference of `push_source_ticks` is the idle rate of the session. It is measured as the increase of `state_loss_ticks` per second of `stop_offset_actual_ms` over all 120 rows of the live study.
- There are 30 runs per configuration and none is discarded. The first run of a session is marked in the column `first_run` and not filtered out.
- The dispatch latency of E2B is part of the interruption time and is in the CSV as `restore_dispatch_ms`. The notebook splits its two groups at the largest distance between two runs (`dispatch_gap`).

## Team

- Author: Jane Schönfeld (Master's student at HAW Kiel, working student at CODEANKER)
- Co-authors and supervision: Dr. Nils Mohr (CODEANKER), Prof. Dr. Malte Prieß (HAW Kiel)

## Use of Generative AI

Generative AI tools were used as assistants in this project, under the authors' direction and review. The authors take full responsibility for the entire content and narrative of the paper and of this repository.

| Tool | Used for |
|---|---|
| Claude Code (Anthropic) with Claude Opus 5 and Claude Opus 5.5 | Structuring (ideas, outline), drafting of sections revised by the authors, editorial revision, literature search, implementation of the measurement setup, the analysis scripts and the code of the figures, as well as testing of the measurement setup and analysis scripts |
| Google NotebookLM, Gemini 3.5 | Literature search |

How the authors ensured ownership of the results:

- All measurements were carried out by the authors on the infrastructure described in the paper. The raw data and analysis scripts are included in this repository ([`data/`](data/), [`analysis/distribution.py`](analysis/distribution.py)).
- All measured numbers reported in the paper can be reproduced from the raw data with these scripts.
- All cited sources were checked against the original publications.
- AI-generated code was reviewed and tested by the authors before use.

## License

The code and the data are released under the MIT License, see [`LICENSE`](LICENSE).
