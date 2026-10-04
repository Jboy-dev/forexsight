#!/usr/bin/env bash
# deploy.sh — the ONLY way this site should be deployed.
#
# Stamps a unique build id into service-worker.js first. Without that stamp the
# file's bytes are unchanged, the browser does not install a new worker, and an
# installed phone app keeps serving the old shell from cache however many times
# it is opened. Doing this by hand was unreliable, so it is not done by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

# Restore the placeholder, then stamp, so re-running is always clean.
python3 - "$BUILD" <<'PY'
import re, sys
build = sys.argv[1]
p = 'service-worker.js'
s = open(p).read()
s = re.sub(r"const BUILD = '[^']*';", f"const BUILD = '{build}';", s, count=1)
open(p, 'w').write(s)
print(f'  stamped build {build}')
PY

# Asset URLs carry ?v=N. The service worker gets a fresh cache on every deploy,
# but the BROWSER's own HTTP cache is keyed on the URL, so an unchanged ?v=N can
# still serve yesterday's knowledge.js from disk. Bumping it by hand was going to
# be forgotten, so the build id is stamped in here.
#
# ONLY .js and .css are stamped. The manifest and the icons carry their own
# deliberate key, bumped by hand when the icon actually changes, and that key is
# part of the installed app's identity — rewriting it on every deploy invites iOS
# to treat the home-screen app as a different app. An unkeyed manifest link has
# already killed it once.
#
# The originals are copied aside and restored BYTE FOR BYTE afterwards. An
# earlier version rewrote every ?v= to a single literal on the way back and
# silently flattened manifest.json?v=610 and base.css?v=3 to ?v=8.
for f in index.html v2/index.html; do
  [ -f "$f" ] && cp "$f" "/tmp/fs-deploy-$(echo "$f" | tr / _).orig"
done
python3 - "$BUILD" <<'PY2'
import re, sys
build = sys.argv[1]
n = 0
for p in ('index.html', 'v2/index.html'):
    try: s = open(p).read()
    except FileNotFoundError: continue
    # Only the files whose CONTENT changes per deploy. Matches href/src ending
    # .js or .css immediately before the query, so manifest.json and the pngs
    # are left exactly as they are.
    s2, k = re.subn(r'(\.(?:js|css))\?v=[A-Za-z0-9._-]+', r'\1?v=' + build, s)
    if k: open(p, 'w').write(s2); n += k
print(f'  stamped {n} asset urls')
PY2

echo "  deploying..."
npx wrangler pages deploy . --project-name=forexsight-preview --branch=main --commit-dirty=true 2>&1 | tail -3

# Leave the placeholder in git so the stamp is never committed as a real value.
python3 -c "
import re
p='service-worker.js'; s=open(p).read()
s=re.sub(r\"const BUILD = '[^']*';\", \"const BUILD = '__BUILD__';\", s, count=1)
open(p,'w').write(s)"
for f in index.html v2/index.html; do
  b="/tmp/fs-deploy-$(echo "$f" | tr / _).orig"
  [ -f "$b" ] && mv "$b" "$f"
done
echo "  build id: $BUILD  (placeholder restored in the working tree)"
