#!/usr/bin/env bash
# Tests check-commit-messages.sh against commits made in throwaway git repositories.
#
# Usage: .github/scripts/test-check-commit-messages.sh
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-commit-messages.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Keep the user's and the system's git settings out of the throwaway repositories
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com

passed=0
failed=0
output=''

pass() {
	passed=$((passed + 1))
}

fail() {
	failed=$((failed + 1))
	printf 'FAIL: %s\n' "$1"
	if [[ -n "$output" ]]; then
		sed 's/^/    | /' <<<"$output"
	fi
}

# A new repository with one commit, tagged "base"
new_repo() {
	local dir
	dir="$(mktemp -d "$work/repo.XXXXXX")"
	git -C "$dir" init -q -b main
	git -C "$dir" commit -q --allow-empty -m 'chore: start'
	git -C "$dir" tag base
	printf '%s' "$dir"
}

# Commit a message byte for byte, without git's clean up of whitespace and line endings
commit_verbatim() {
	local dir="$1" message="$2" sha
	sha="$(printf '%s' "$message" | git -C "$dir" commit-tree "HEAD^{tree}" -p HEAD)"
	git -C "$dir" update-ref HEAD "$sha"
}

# run <dir> <range>: sets $status and $output
run() {
	set +e
	output="$(cd "$1" && "$script" "$2" 2>&1)"
	status=$?
	set -e
}

# expect accept|reject <message> [text the output must contain]
expect() {
	local want="$1" message="$2" contains="${3:-}" dir name
	name="$want $(printf '%q' "$message")"
	dir="$(new_repo)"
	commit_verbatim "$dir" "$message"
	run "$dir" base..HEAD
	if [[ "$want" == accept && $status -ne 0 ]] || [[ "$want" == reject && $status -eq 0 ]]; then
		fail "$name (exit $status)"
	elif [[ -n "$contains" && "$output" != *"$contains"* ]]; then
		fail "$name: the output does not contain '$contains'"
	else
		pass
	fi
}

# expect_range accept|reject <range>, in a repository with a few good commits
expect_range() {
	local want="$1" range="$2"
	run "$range_repo" "$range"
	if [[ "$want" == accept && $status -ne 0 ]] || [[ "$want" == reject && $status -eq 0 ]]; then
		fail "$want range $(printf '%q' "$range") (exit $status)"
	elif [[ "$want" == reject && "$output" == *"follow Conventional Commits"* ]]; then
		fail "reject range $(printf '%q' "$range"): it printed success"
	else
		pass
	fi
}

nl=$'\n'
crlf=$'\r\n'
trailers="Co-Authored-By: Someone <someone@example.com>${nl}Claude-Session: https://claude.ai/code/session_x"

# --- subjects -------------------------------------------------------------------------------

expect accept 'feat: add a thing'
expect accept 'fix(routing): keep the selection'
expect accept 'feat(routing)!: x'
expect accept "refactor!: x${nl}${nl}BREAKING CHANGE: the old name is gone"
expect accept "docs: say what CI enforces${nl}${nl}A body.${nl}${nl}${trailers}"
expect reject 'feature: add a thing' "the subject must be"
expect reject 'feat:add a thing' "the subject must be"
expect reject 'Feat: add a thing' "the subject must be"
expect reject 'feat(): x' "the subject must be"
expect reject 'feat(a b): x' "the subject must be"
expect reject 'fixup! feat: add a thing' "the subject must be"
expect reject 'squash! feat: add a thing' "the subject must be"
expect reject 'amend! feat: add a thing' "the subject must be"
expect reject "feat: x${nl}a body straight after the subject" "followed by a blank line"

# --- exemptions -----------------------------------------------------------------------------

expect accept 'Bump vitest from 3.2.4 to 3.2.5'
expect accept 'Bump vitest from 3.2.4 to 3.2.5 in /docs'
expect accept 'Bump actions/cache from 4 to 5'
expect accept 'Bump the npm group with 3 updates'
expect accept 'Bump the npm group across 1 directory with 2 updates'
expect accept 'Bump the npm_and_yarn group in /docs with 1 update'
expect accept 'Bump foo and bar'
expect accept 'Bump foo and bar in /docs'
expect accept 'Bump foo, bar and baz'
expect accept 'Revert "feat: add a thing"'
expect accept 'Reapply "feat: add a thing"'
expect accept 'Revert "Revert "feat: add a thing""'
expect reject 'Bump x from 1 to 2 and also rewrite everything' "the subject must be"
expect reject 'Bump the npm group and also rewrite everything' "the subject must be"
expect reject 'Bump foo and bar and also rewrite everything' "the subject must be"
expect reject 'Bump x from 1 to 2 in /docs and more' "the subject must be"
expect reject 'Revert "feat: x" and more' "the subject must be"
expect reject 'Reapply feat: x' "the subject must be"

# --- breaking change footers ----------------------------------------------------------------

expect accept "feat!: x${nl}${nl}BREAKING CHANGE: y"
expect accept "feat!: x${nl}${nl}BREAKING-CHANGE: y"
expect accept "feat!: x${nl}${nl}BREAKING CHANGE: y${nl}  continued on the next line${nl}${trailers}"
expect accept "feat: x${nl}${nl}Breaking changes: this explains the risk${nl}${nl}${trailers}"
expect accept "feat: x${nl}${nl}Breaking changes: this explains the risk${nl}${nl}More of the body."
expect accept "feat: x${nl}${nl}Some prose.${nl}breaking change: in the middle of a paragraph"
expect reject "feat!: x${nl}${nl}BREAKING CHANGE - y" "not 'BREAKING CHANGE - y'"
expect reject "feat!: x${nl}${nl}  BREAKING CHANGE: y" "not '  BREAKING CHANGE: y'"
expect reject "feat!: x${nl}${nl}BREAKING CHANGES: y" "not 'BREAKING CHANGES: y'"
expect reject "feat!: x${nl}${nl}breaking change: y" "not 'breaking change: y'"
expect reject "feat!: x${nl}${nl}${trailers}${nl}BREAKING CHANGES: y" "not 'BREAKING CHANGES: y'"
expect reject "feat!: x${nl}${nl}A body.${nl}${nl}Refs: #12${nl}breaking-change: y" "not 'breaking-change: y'"

# --- Windows line endings -------------------------------------------------------------------

expect accept "feat: x${crlf}${crlf}A body.${crlf}${crlf}BREAKING CHANGE: y${crlf}"
expect accept "feat: x${nl} ${nl}A whitespace only line after the subject."
expect accept "feat: x${crlf} ${crlf}A body."
expect reject "feat: x${crlf}a body straight after the subject" "followed by a blank line"
expect reject "nope: x${crlf}${crlf}A body." '::error::'

# --- escaping of workflow commands ----------------------------------------------------------

expect reject 'chore 100% wrong' '"chore 100%25 wrong"'
dir="$(new_repo)"
run "$dir" $'base..HEAD\nfoo'
if [[ $status -ne 0 && "$output" == *'%0A'* && "$output" != *$'\n'foo* ]]; then pass; else fail "escape a newline in the range"; fi
run "$dir" $'base..HE\rAD'
if [[ $status -ne 0 && "$output" == *'%0D'* ]]; then pass; else fail "escape a carriage return in the range"; fi

# --- ranges ---------------------------------------------------------------------------------

range_repo="$(new_repo)"
commit_verbatim "$range_repo" 'feat: one'
commit_verbatim "$range_repo" 'fix: two'
unknown="$(printf '%040d' 0 | tr 0 d)"

expect_range accept base..HEAD
expect_range accept base..main
expect_range accept "$(git -C "$range_repo" rev-parse base)..$(git -C "$range_repo" rev-parse HEAD)"
expect_range accept HEAD..HEAD
expect_range reject nosuchref..HEAD
expect_range reject base..nosuchref
expect_range reject ..
expect_range reject base..
expect_range reject ..HEAD
expect_range reject 'foo bar'
expect_range reject 'base ..HEAD'
expect_range reject "$unknown..HEAD"
expect_range reject deadbeef..HEAD
expect_range reject HEAD
expect_range reject base
expect_range reject --all
expect_range reject base...HEAD
expect_range reject base..HEAD..HEAD
expect_range reject -n1..HEAD
expect_range reject "base..HEAD^{tree}"

# git rev-list failing after both ends were checked (a commit in the middle is missing) still fails
dir="$(new_repo)"
commit_verbatim "$dir" 'feat: one'
middle="$(git -C "$dir" rev-parse HEAD)"
commit_verbatim "$dir" 'fix: two'
run "$dir" base..HEAD
if [[ $status -eq 0 ]]; then pass; else fail "the setup for a broken repository"; fi
rm "$dir/.git/objects/${middle:0:2}/${middle:2}"
run "$dir" base..HEAD
if [[ $status -ne 0 && "$output" != *"follow Conventional Commits"* ]]; then
	pass
else
	fail "a missing commit object (exit $status)"
fi

# a merge commit is skipped
dir="$(new_repo)"
git -C "$dir" checkout -q -b side
commit_verbatim "$dir" 'feat: on a branch'
git -C "$dir" checkout -q main
commit_verbatim "$dir" 'fix: on main'
git -C "$dir" merge -q --no-ff -m "Merge branch 'side'" side
run "$dir" base..HEAD
if [[ $status -eq 0 ]]; then pass; else fail "skip a merge commit"; fi

echo
echo "$passed passed, $failed failed"
((failed == 0))
