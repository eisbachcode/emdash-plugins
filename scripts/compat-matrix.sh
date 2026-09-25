#!/usr/bin/env bash
#
# Run every harness-backed plugin suite against a list of EmDash versions and
# print which combinations pass.
#
# Why this exists: `@emdash-cms/plugin-test` pins `emdash` exactly (0.2.0 pins
# 0.39.0), so out of the box a plugin is only ever tested against the one host
# version the harness chose. pnpm `overrides` rewire the harness's own pinned
# dependency, which is how a range becomes testable at all.
#
# That is a workaround, not a supported path. Nothing stops a future plugin-test
# from importing a symbol that exists only in its pinned host, and the failure
# would look like a plugin bug. The baseline row (no overrides) is therefore not
# optional: it is what tells a harness breakage apart from a plugin regression.
#
# Only packages with a `vitest.config.ts` are run -- those are the ones using
# the workerd harness. `shared` uses plain vitest with no host, and a `link:`ed
# package has no npm versions to override against.
#
# Usage: scripts/compat-matrix.sh [version...]      (default: 0.39.1 0.40.0)

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

VERSIONS=("${@:-}")
[ -z "${VERSIONS[0]:-}" ] && VERSIONS=(0.39.1 0.40.0)

if [ -n "$(git status --porcelain pnpm-workspace.yaml pnpm-lock.yaml)" ]; then
	echo "refusing to run: pnpm-workspace.yaml or pnpm-lock.yaml already modified" >&2
	exit 1
fi

PKGS=()
for d in packages/*/; do
	[ -f "${d}vitest.config.ts" ] && PKGS+=("$(basename "${d%/}")")
done
[ ${#PKGS[@]} -eq 0 ] && { echo "no harness-backed packages found" >&2; exit 1; }

restore() {
	git checkout -- pnpm-workspace.yaml pnpm-lock.yaml 2>/dev/null || true
	pnpm install --no-frozen-lockfile >/dev/null 2>&1 || true
}
trap restore EXIT INT TERM

# Results accumulate as "label|package|value" lines: macOS ships bash 3.2,
# which has no associative arrays, and this has to run here and in CI.
RESULTS=""
FAILED=0

record() { RESULTS="${RESULTS}${1}|${2}|${3}
"; }

lookup() {
	printf '%s' "$RESULTS" | awk -F'|' -v l="$1" -v p="$2" '$1==l && $2==p {print $3; found=1} END {if (!found) print "?"}' | head -1
}

run_suites() {
	label="$1"
	# --no-frozen-lockfile because CI=true makes pnpm imply the opposite, and
	# rewriting the lockfile is the entire point of the override rows.
	if ! install_out=$(pnpm install --no-frozen-lockfile 2>&1); then
		echo "  install failed for $label:"
		printf '%s\n' "$install_out" | tail -15 | sed 's/^/    /'
		for p in "${PKGS[@]}"; do record "$label" "$p" "install-fail"; done
		FAILED=1
		return
	fi
	for p in "${PKGS[@]}"; do
		if out=$(cd "packages/$p" && pnpm vitest run 2>&1); then
			# `|| true` matters: with `set -eo pipefail` a grep that matches
			# nothing would kill the script and hide the reason.
			n=$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'Tests +[0-9]+ passed' | grep -oE '[0-9]+' | head -1 || true)
			if [ -z "$n" ]; then
				# The table is cross-checked against the counts published in
				# each README, so a missing number is worth a line rather than
				# a silent "passed". Show what the summary actually looked like.
				echo "  note: no test count parsed for $p ($label); summary was:"
				printf '%s\n' "$out" | tail -6 | sed 's/^/    /'
			fi
			record "$label" "$p" "${n:-passed}"
		else
			echo "  $p failed against $label:"
			printf '%s\n' "$out" | tail -25 | sed 's/^/    /'
			record "$label" "$p" "FAIL"
			FAILED=1
		fi
	done
}

echo "baseline (harness's own pinned host, no overrides)"
run_suites "baseline"

for v in "${VERSIONS[@]}"; do
	echo "emdash $v"
	git checkout -- pnpm-workspace.yaml pnpm-lock.yaml
	cat >> pnpm-workspace.yaml <<-EOF

	overrides:
	  emdash: $v
	  "@emdash-cms/cloudflare": $v
	  "@emdash-cms/blocks": $v
	EOF
	run_suites "$v"
done

echo
printf '%-26s %-12s' "package" "baseline"
for v in "${VERSIONS[@]}"; do printf '%-12s' "$v"; done
echo
for p in "${PKGS[@]}"; do
	printf '%-26s %-12s' "$p" "$(lookup baseline "$p")"
	for v in "${VERSIONS[@]}"; do printf '%-12s' "$(lookup "$v" "$p")"; done
	echo
done
echo
echo "numbers are passing tests; FAIL or install-fail means the combination is not supported"

if [ "$FAILED" -ne 0 ]; then
	echo
	echo "at least one combination failed"
	exit 1
fi
