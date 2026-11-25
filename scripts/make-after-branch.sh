#!/usr/bin/env bash
# Creates the `after/config` branch: the staged "after" state for Section 4.
# Run once, locally, after `git init` on main. A straggler can then
# `git checkout after/config` to catch up to the configured repo.
set -e
git checkout -b after/config
cp config/CLAUDE.md.after CLAUDE.md
mkdir -p .claude
cp config/settings.json.after .claude/settings.json
git add -A
git add -f .claude/settings.json   # gitignored on main, tracked here
git commit -m "after(config): tight CLAUDE.md + permissions.deny for Section 4"
git checkout main
echo "after/config branch created; back on main."
