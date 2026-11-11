#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  printf 'Usage: scripts/mini.sh <command...>\n' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$HOME/.local/share/my-ai-skills/main/skills/supervise/scripts/fleetcapacity.py" --need-mini
ssh mini 'mkdir -p "$HOME/worktrees/poker-banker" "$HOME/tools"'
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.vercel/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.env*' \
  --exclude='.cache/' \
  --exclude='.local-db/' \
  --exclude='.postgres/' \
  --exclude='test-results/' \
  --exclude='playwright-report/' \
  --exclude='evidence/' \
  "$repo_root/" mini:worktrees/poker-banker/

remote_command='bash -s --'
for argument in "$@"; do
  printf -v quoted_argument '%q' "$argument"
  remote_command+=" $quoted_argument"
done

set +e
ssh mini "$remote_command" <<'REMOTE'
set -euo pipefail
node_home="$HOME/tools/node22"
if [[ ! -x "$node_home/bin/node" ]]; then
  download_dir="$(mktemp -d "$HOME/tools/.node22-download.XXXXXX")"
  trap 'rm -rf "$download_dir"' EXIT
  curl --fail --silent --show-error --location \
    https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt \
    --output "$download_dir/SHASUMS256.txt"
  archive="$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-darwin-arm64\.tar\.gz$/ { print $2 }' "$download_dir/SHASUMS256.txt")"
  [[ "$archive" =~ ^node-v22\.[0-9]+\.[0-9]+-darwin-arm64\.tar\.gz$ ]]
  version="${archive#node-}"
  version="${version%-darwin-arm64.tar.gz}"
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/$version/$archive" \
    --output "$download_dir/$archive"
  awk -v archive="$archive" '$2 == archive' "$download_dir/SHASUMS256.txt" > "$download_dir/CHECKSUM"
  (cd "$download_dir" && shasum -a 256 -c CHECKSUM)
  mkdir -p "$node_home"
  tar -xzf "$download_dir/$archive" -C "$node_home" --strip-components=1
  rm -rf "$download_dir"
  trap - EXIT
fi
export PATH="$node_home/bin:$PATH"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]]
cd "$HOME/worktrees/poker-banker"
corepack enable --install-directory "$node_home/bin"
pnpm install --frozen-lockfile
"$@"
REMOTE
command_status=$?
set -e

copy_status=0
for output_directory in test-results evidence; do
  set +e
  ssh mini "test -d \"\$HOME/worktrees/poker-banker/$output_directory\""
  probe_status=$?
  set -e
  if [[ $probe_status -eq 0 ]]; then
    mkdir -p "$repo_root/$output_directory"
    rsync -az "mini:worktrees/poker-banker/$output_directory/" "$repo_root/$output_directory/" || copy_status=$?
  elif [[ $probe_status -ne 1 ]]; then
    copy_status=$probe_status
  fi
done

if [[ $command_status -ne 0 ]]; then
  exit "$command_status"
fi
exit "$copy_status"
