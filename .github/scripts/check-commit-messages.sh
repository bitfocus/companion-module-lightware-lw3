#!/usr/bin/env bash
# Checks that every non-merge commit in a git revision range follows
# Conventional Commits (https://www.conventionalcommits.org/en/v1.0.0/).
#
# Usage: .github/scripts/check-commit-messages.sh <base>..<head>
#
# Tested by .github/scripts/test-check-commit-messages.sh.
set -euo pipefail

# Escape text for a GitHub workflow command, as https://github.com/actions/toolkit does
escape() {
	local text="${1//'%'/%25}"
	text="${text//$'\r'/%0D}"
	printf '%s' "${text//$'\n'/%0A}"
}

usage="usage: $0 <base>..<head>"
range="${1:?$usage}"

# Exactly one "..", with a revision on each side: no bare revision, "A...B" or option such as --all
if [[ "$range" == *...* || ! "$range" =~ ^([^[:space:]]+)\.\.([^[:space:]]+)$ ]]; then
	echo "::error::$(escape "the range must be '<base>..<head>', not '$range'")" >&2
	exit 2
fi
base="${BASH_REMATCH[1]}"
head="${BASH_REMATCH[2]}"
for rev in "$base" "$head"; do
	if [[ "$rev" == -* || "$rev" == *..* ]] || ! git rev-parse --quiet --verify "$rev^{commit}" >/dev/null; then
		echo "::error::$(escape "'$rev' in the range '$range' is not a commit")" >&2
		exit 2
	fi
done

# Read the list first, so that a failing git rev-list stops the script under set -e
shas="$(git rev-list --no-merges --reverse "$base..$head")"
mapfile -t shas <<<"$shas"

types='feat|fix|refactor|perf|test|docs|chore|ci|build'
# type, optional (scope), optional ! for a breaking change, then ": description"
header="^($types)(\([^()[:space:]]+\))?!?: [^[:space:]]"
# Dependabot ("Bump x from 1.0.0 to 1.0.1", "Bump x and y in /dir", "Bump the npm group ...")
# and git reverts and reapplies. Each form is anchored at both ends, so nothing can follow it.
word='[^[:space:]]+'
dir="( in /$word| in /)?"
group="( in the $word group( across [0-9]+ director(y|ies))?)?"
exempt="^(Bump $word from $word to $word$dir$group"
exempt+="|Bump the $word group$dir( across [0-9]+ director(y|ies))? with [0-9]+ updates?"
exempt+="|Bump $word(, $word)* and $word$dir"
exempt+='|(Revert|Reapply) ".+")$'

# A git trailer ("Token: value", "Token #value") and anything that looks like a breaking change footer
footer='^[[:alnum:]][[:alnum:]-]*(: | #)'
breaking_like='^[[:space:]]*breaking[[:space:]_-]*changes?([^[:alnum:]]|$)'
breaking='^BREAKING[ -]CHANGE: [^[:space:]]'

is_blank() {
	[[ -z "${1//[[:space:]]/}" ]]
}

# Print the lines of the final paragraph if it is a block of footers, nothing otherwise
footer_block() {
	local -a lines=() last=()
	local line
	mapfile -t lines <<<"$1"
	local start=-1 i
	for ((i = ${#lines[@]} - 1; i > 0; i--)); do
		if is_blank "${lines[i]}"; then
			start=$((i + 1))
			break
		fi
	done
	# a message without a body has no footers
	((start > 0 && start < ${#lines[@]})) || return 0
	last=("${lines[@]:start}")
	local lower first=1
	for line in "${last[@]}"; do
		lower="${line,,}"
		if [[ "$line" =~ $footer || "$lower" =~ $breaking_like ]]; then
			:
		elif ((first == 0)) && [[ "$line" =~ ^[[:space:]] ]]; then
			: # a continuation of the footer above
		else
			return 0
		fi
		first=0
	done
	printf '%s\n' "${last[@]}"
}

failed=0
for sha in "${shas[@]}"; do
	[[ -n "$sha" ]] || continue
	message="$(git log -1 --format=%B "$sha")"
	message="${message//$'\r'/}"
	subject="$(head -n 1 <<<"$message")"
	short="$(git rev-parse --short "$sha")"
	errors=()

	if [[ "$subject" =~ $exempt ]]; then
		continue
	fi
	if ! [[ "$subject" =~ $header ]]; then
		errors+=("the subject must be '<type>[(scope)][!]: <description>' with a type of ${types//|/, }")
	fi
	if ! is_blank "$(sed -n 2p <<<"$message")"; then
		errors+=("the subject must be followed by a blank line")
	fi
	# A breaking change footer must be spelt "BREAKING CHANGE: " or "BREAKING-CHANGE: "
	while IFS= read -r line; do
		lower="${line,,}"
		if [[ "$lower" =~ $breaking_like ]] && ! [[ "$line" =~ $breaking ]]; then
			errors+=("write the breaking change footer as 'BREAKING CHANGE: <description>', not '$line'")
		fi
	done < <(footer_block "$message")

	if ((${#errors[@]})); then
		failed=1
		echo "::error::$(escape "$short \"$subject\"")"
		printf '  - %s\n' "${errors[@]}"
	fi
done

if ((failed)); then
	echo
	echo "See the Contributing section of README.md."
	exit 1
fi
echo "All commit messages in $range follow Conventional Commits."
