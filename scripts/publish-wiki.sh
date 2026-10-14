#!/usr/bin/env bash
# Publishes wiki/ (the user guide, kept with the code) to the repository's GitHub wiki, which is a git repository of
# its own (<repo>.wiki.git). The wiki must exist first: Settings → Features → Wikis, then create any first page on
# github.com (GitHub makes the wiki repository only then). Pages are replaced by wiki/'s; pages only on the wiki stay.
#
#   bash scripts/publish-wiki.sh            # origin's wiki
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
origin="$(git -C "$root" remote get-url origin)"
wiki_url="${origin%.git}.wiki.git"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 "$wiki_url" "$work/wiki"
cp "$root"/wiki/*.md "$work/wiki/"
cd "$work/wiki"
git add -A
if git diff --cached --quiet; then
  echo "wiki already up to date"
  exit 0
fi
git commit --quiet -m "Guide from $(git -C "$root" rev-parse --short HEAD)"
git push --quiet
echo "published to $wiki_url"
