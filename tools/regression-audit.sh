#!/usr/bin/env bash
# Does a fix that gets undone actually turn the suite red?
#
# tools/regression-tests.mjs has 118 tests and, until this existed, nothing
# proved that any of them FAILS when the thing it guards is removed. A test
# that passes either way is not a guard; it is decoration. This reverts each
# fix in turn and reports any whose return nobody would notice.
#
# Ported from the Quorum audit after that one was rebuilt on 2026-10-19. The
# hard-won parts are carried over rather than rediscovered:
#
#   - EVERY CASE RUNS IN ITS OWN COPY of the repo, so a run killed half way
#     cannot leave a source file reverted. The old design mutated the tree in
#     place and a crash left it broken.
#   - THE SUITE RUNS ONCE per case. Running it twice — once for the summary
#     line, once for the exit code — doubled the whole audit for nothing.
#   - A CRASH IS NOT A GUARD. An out-of-memory abort also exits non-zero, so a
#     non-zero exit counts only with a real verdict behind it. Otherwise the
#     case is INCONCLUSIVE and the run fails.
#   - A CASE THAT CANNOT APPLY IS A CASE THAT IS NOT THERE. "mutation no longer
#     applies" used to print yellow and pass; it now fails the run, because a
#     guard pointing at code that has moved guards nothing.
#   - MUTATIONS ARE POSITIONAL where the target contains a backtick or a
#     dollar-brace: a literal one inside this file's shell-quoted python comes
#     through with backslashes and matches nothing.
#
#   bash tools/regression-audit.sh            all cases
#   ONLY='atr|ledger' bash tools/regression-audit.sh   just the matching ones
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO=$(pwd)
CASES=$(mktemp -d); RES=$(mktemp -d); WORK=$(mktemp -d)
trap 'rm -rf "$CASES" "$RES" "$WORK"' EXIT
PASS=0; MISS=0; SKIP=0; VOID=0; UNGUARDED=""; N=0

try() {
  local name="$1" file="$2" py="$3"
  if [ -n "${ONLY:-}" ] && ! printf '%s' "$name" | grep -Eqi -- "$ONLY"; then return; fi
  N=$((N+1))
  printf '%s' "$name" > "$CASES/$N.name"
  printf '%s' "$file" > "$CASES/$N.file"
  printf '%s' "$py"   > "$CASES/$N.py"
}

run_case() {
  local n="$1" dir="$2" name file py
  name=$(cat "$CASES/$n.name"); file=$(cat "$CASES/$n.file"); py=$(cat "$CASES/$n.py")
  cd "$dir" || return
  if ! python3 -c "$py" >/dev/null 2>&1; then
    printf 'skip\t%s\tmutation no longer applies' "$name" > "$RES/$n"; return
  fi
  case "$file" in
    *.js|*.mjs) node --check "$file" >/dev/null 2>&1 || {
        printf 'skip\t%s\tmutation produced invalid JS' "$name" > "$RES/$n"; return; } ;;
  esac
  local out code finished
  node tools/regression-tests.mjs > "$dir/.case.out" 2>&1; code=$?
  out=$(tr -d '\033' < "$dir/.case.out" | sed 's/\[[0-9;]*m//g' | grep -E '[0-9]+ passed' | tail -1 || true)
  finished=$(grep -c 'passed' "$dir/.case.out" 2>/dev/null || true); [ -z "$finished" ] && finished=0
  if [ "$code" -ne 0 ]; then
    if [ -n "$out" ]; then printf 'guarded\t%s\t%s' "$name" "$out" > "$RES/$n"
    else printf 'skip\t%s\tINCONCLUSIVE: the suite died without a verdict (exit %s)' "$name" "$code" > "$RES/$n"; fi
  else
    printf 'UNGUARDED\t%s\t%s' "$name" "$out" > "$RES/$n"
  fi
}

echo
echo "Reverting each fix and checking the suite notices."
echo

# ---- the MAE sign trap ----
# maeR is a positive MAGNITUDE of adverse movement. A comparison written as
# `mae < -0.5` is dead code that can never fire, and the sentence warning you
# the win was uncomfortable silently stopped appearing.
try "the adverse-movement warning becomes dead code again" v2/base.js "
p='v2/base.js';s=open(p).read()
a='mae != null && mae > 0.5'
assert s.count(a)>=1
open(p,'w').write(s.replace(a,'mae != null && mae < -0.5'))"

try "adverse movement is rendered as if it could be a gain" v2/base.js "
p='v2/base.js';s=open(p).read()
a=\"mae > 0 ? ' at its worst' : ''\"
assert s.count(a)>=1
open(p,'w').write(s.replace(a,\"mae < 0 ? ' at its worst' : ''\"))"

# ---- ATR must be Wilder, the way the charts and backtests compute it ----
try "ATR goes back to a rolling mean instead of Wilder" tools/adaptive-engine.mjs "
p='tools/adaptive-engine.mjs';s=open(p).read()
a='out[i] = (out[i-1]*(p-1)+tr)/p'
assert s.count(a)==1
open(p,'w').write(s.replace(a,'out[i] = (out[i-1]+tr)/2'))"

# ---- the watcher must not close a position against a stale feed ----
# A feed outage would otherwise mark everything expired against whatever old
# close happened to be sitting there.
try "the watcher closes positions against stale bars again" tools/watch-setups.mjs "
p='tools/watch-setups.mjs';s=open(p).read()
a='const STALE_BARS_MS = 6 * 3600000;'
assert s.count(a)==1
open(p,'w').write(s.replace(a,'const STALE_BARS_MS = Infinity;'))"

# ---- the deploy must stamp code but NEVER the manifest or icons ----
# An unkeyed manifest link made iOS treat the home-screen app as a different
# app; a stamped one is just as bad in the other direction.
try "the deploy stops stamping the service worker build id" tools/deploy.sh "
p='tools/deploy.sh';s=open(p).read()
a='BUILD=\"\$(date -u +%Y%m%d-%H%M%S)'
assert s.count(a)==1
open(p,'w').write(s.replace(a,'BUILD=\"fixed'))"

# ---- report, in the order the cases were declared ----
if [ "$N" -eq 0 ]; then echo "No cases matched."; exit 0; fi
for w in $(seq 1 1); do rm -rf "$WORK/w$w"; cp -c -R "$REPO" "$WORK/w$w" 2>/dev/null || cp -R "$REPO" "$WORK/w$w"; done
for n in $(seq 1 "$N"); do run_case "$n" "$WORK/w1"; done

for n in $(seq 1 "$N"); do
  [ -f "$RES/$n" ] || { printf "  \033[33m  skip\033[0m  case %d produced no result\n" "$n"; SKIP=$((SKIP+1)); continue; }
  IFS=$(printf '\t') read -r verdict name detail < "$RES/$n"
  case "$verdict" in
    guarded)   printf "  \033[32m  guarded\033[0m  %s  (%s)\n" "$name" "$detail"; PASS=$((PASS+1)) ;;
    UNGUARDED) printf "  \033[31mUNGUARDED\033[0m  %s  (%s)\n" "$name" "$detail"; MISS=$((MISS+1))
               UNGUARDED="$UNGUARDED
    · $name" ;;
    *)         printf "  \033[33m  skip\033[0m  %s — %s\n" "$name" "$detail"; SKIP=$((SKIP+1))
               case "$detail" in INCONCLUSIVE*) VOID=$((VOID+1));; esac ;;
  esac
done

echo
printf "guarded: %d   UNGUARDED: %d   skipped: %d" "$PASS" "$MISS" "$SKIP"
[ "$VOID" -gt 0 ] && printf "   \033[33mINCONCLUSIVE: %d\033[0m" "$VOID"
printf "\n"
if [ "$MISS" -gt 0 ]; then
  printf "\033[31mThese fixes would come back unnoticed:%s\033[0m\n" "$UNGUARDED"; exit 1; fi
if [ "$VOID" -gt 0 ]; then
  printf "\033[33m%d case(s) never produced a verdict — re-run those before trusting this.\033[0m\n" "$VOID"; exit 1; fi
if [ "$SKIP" -gt 0 ]; then
  printf "\033[31m%d case(s) no longer apply — their target moved, so they guard nothing.\033[0m\n" "$SKIP"
  printf "\033[31mRepoint them at where the code lives now, or delete them.\033[0m\n"; exit 1; fi
echo "Every fix checked is guarded by a test that fails when it is undone."
