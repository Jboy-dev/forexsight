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
# be forgotten, so the build id is stamped into it here and restored afterwards.
python3 - "$BUILD" <<'PY2'
import re, sys, glob
build = sys.argv[1]
n = 0
for p in ('index.html', 'v2/index.html'):
    try: s = open(p).read()
    except FileNotFoundError: continue
    s2, k = re.subn(r'\?v=[A-Za-z0-9._-]+', '?v=' + build, s)
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
python3 - "$BUILD" <<'PY3'
import re, sys
build = sys.argv[1]
for p in ('index.html', 'v2/index.html'):
    try: s = open(p).read()
    except FileNotFoundError: continue
    open(p, 'w').write(s.replace('?v=' + build, '?v=8'))
PY3
echo "  build id: $BUILD  (placeholder restored in the working tree)"
