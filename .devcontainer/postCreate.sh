#!/usr/bin/env bash
set -e

node -v
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm -v

pnpm install
npx --yes playwright install --with-deps chromium

apt-get update
apt-get install -y --no-install-recommends \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-fonts-extra \
  texlive-lang-german \
  texlive-bibtex-extra \
  texlive-publishers \
  texlive-science \
  biber \
  latexmk
rm -rf /var/lib/apt/lists/*
