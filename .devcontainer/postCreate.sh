#!/usr/bin/env bash
set -e

node -v
npm install -g pnpm@12.14.0
pnpm -v

curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
uv --version

pnpm install
pnpm exec playwright install --with-deps chromium

apt-get update
apt-get install -y --no-install-recommends \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-fonts-extra \
  texlive-bibtex-extra \
  texlive-publishers \
  texlive-science \
  biber \
  latexmk
rm -rf /var/lib/apt/lists/*
