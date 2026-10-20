#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 SNAPSHOT_DATE [--refresh]" >&2
}

snapshot_date="${1:-}"
if [[ -z "$snapshot_date" ]]; then
  usage
  exit 2
fi
shift

refresh=0
for argument in "$@"; do
  case "$argument" in
    --refresh) refresh=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $argument" >&2
      usage
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

refresh_flag=""
if ((refresh)); then
  refresh_flag="--refresh"
fi

run_step() {
  printf '\n==> %s\n' "$1"
  shift
  "$@"
}

run_step "N03 boundaries ($snapshot_date)" \
  uv run japan-flags ingest-current-national \
  --n03-date "$snapshot_date" $refresh_flag

run_step "Prefecture flags (Wikidata P41 / Commons)" \
  uv run japan-flags ingest-current-prefectures \
  --snapshot-date "$snapshot_date" $refresh_flag

run_step "Municipal flags (Wikimedia Commons)" \
  uv run japan-flags fetch-svg-all $refresh_flag

run_step "SVG asset classification" \
  uv run japan-flags classify-svg

run_step "Municipality profiles (Wikidata / Wikipedia)" \
  uv run japan-flags ingest-municipality-profiles \
  --snapshot-date "$snapshot_date" $refresh_flag

if ((refresh)); then
  run_step "Wikipedia emblem and flag lists" \
    uv run japan-flags wikipedia-lists-ingest \
    --snapshot-date "$snapshot_date" --refresh-titles --refresh-pages
  run_step "Commons usage and flag matching" \
    uv run japan-flags match-current-national \
    --snapshot-date "$snapshot_date" --refresh-usage
else
  run_step "Wikipedia emblem and flag lists" \
    uv run japan-flags wikipedia-lists-ingest \
    --snapshot-date "$snapshot_date"
  run_step "Commons usage and flag matching" \
    uv run japan-flags match-current-national \
    --snapshot-date "$snapshot_date"
fi

run_step "Database report" uv run japan-flags report
