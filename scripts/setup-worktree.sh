#!/usr/bin/env bash
set -euo pipefail

npm --prefix worker ci
npm --prefix pwa ci
