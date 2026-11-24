MAIN := main
JOB := paper
BUILD := build

RESULTS_CSV := ../data/results.csv
LIVE_CSV := ../data/live/results.csv
NOTEBOOK := ../analysis/distribution.py

DATA_FIGS := $(if $(wildcard $(RESULTS_CSV)),decomposition)
DATA_FIG_PDFS := $(addprefix figures/,$(addsuffix .pdf,$(DATA_FIGS)))
DATA_FIG_DATS := $(addprefix figures/,$(addsuffix .dat,$(DATA_FIGS)))

STATIC_FIG_PDFS := figures/setup-diagram.pdf

ALL_FIG_PDFS := $(DATA_FIG_PDFS) $(STATIC_FIG_PDFS)

.PHONY: all clean figures fresh

all: $(ALL_FIG_PDFS)
	@mkdir -p $(BUILD)
	@which latexmk >/dev/null 2>&1 && latexmk $(MAIN).tex || $(MAKE) manual
	cp $(BUILD)/$(JOB).pdf $(JOB).pdf

fresh: clean all

figures: $(ALL_FIG_PDFS)

$(STATIC_FIG_PDFS): figures/%.pdf: figures/%.tex
	latexmk -norc -cd -pdf -interaction=nonstopmode -outdir=build $<
	cp figures/build/$*.pdf figures/$*.pdf

figures/decomposition.dat: $(NOTEBOOK) $(RESULTS_CSV) $(LIVE_CSV)
	uv run python $(NOTEBOOK)

figures/%.pdf: figures/%.tex figures/%.dat
	latexmk -norc -cd -pdf -interaction=nonstopmode -outdir=build $<
	cp figures/build/$*.pdf figures/$*.pdf

manual:
	@mkdir -p $(BUILD)
	pdflatex -interaction=nonstopmode -jobname=$(JOB) -output-directory=$(BUILD) $(MAIN).tex
	biber --input-directory $(BUILD) --output-directory $(BUILD) $(JOB)
	pdflatex -interaction=nonstopmode -jobname=$(JOB) -output-directory=$(BUILD) $(MAIN).tex
	pdflatex -interaction=nonstopmode -jobname=$(JOB) -output-directory=$(BUILD) $(MAIN).tex
	cp $(BUILD)/$(JOB).pdf $(JOB).pdf

clean:
	rm -rf $(BUILD) $(JOB).pdf $(JOB).synctex.gz
	rm -rf figures/build $(DATA_FIG_PDFS) $(DATA_FIG_DATS) figures/*.csv
