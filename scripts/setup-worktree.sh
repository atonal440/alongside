#!/usr/bin/env bash
set -euo pipefail

npm ci
npm --prefix worker ci
npm --prefix pwa ci
