#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
exec pnpm exec tsx .claude/skills/verify-poker-banker/scripts/control.ts "$@"
