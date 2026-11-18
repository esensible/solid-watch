#!/bin/sh
# tools/publish.sh — export projects/solid-watch to its public repo, github.com/esensible/solid-watch.
#
# The esensible monorepo is the source of truth; the public repo is a publication target that
# is never edited and never pulled from. An export is ONE curated commit on top of the public
# branch: its tree is projects/solid-watch exactly as it is at REV (projects/solid-watch/
# becomes the root), its single parent is the public branch's head (none while the branch has
# no commits), its author the monorepo's identity (git config user.name / user.email), and its
# message the top entry of CHANGELOG.md (or --message). The monorepo's own commit messages,
# which describe other projects' work, never reach the public repo, and its history is not
# the monorepo's: one public commit per release.
#
# Run it from projects/solid-watch in a monorepo dev container that has git, node (>= 20), npm,
# a C compiler and make (for qjs) and ssh (for a push), and that mounts the whole repository
# (at /workspace) and the host's ~/.ssh. E.g. from the monorepo root:
# .devcontainer/dc exec <container> -- sh /workspace/projects/solid-watch/tools/publish.sh
#
#   sh tools/publish.sh [--message <file-or-text>] [--trailers] [--push <branch>]
#
#   (no --push)          dry run against BRANCH (default main): split, refuse what must not be
#                        public, fetch the public branch, compare trees, compose the message,
#                        check the tree stands alone (below), build the commit; prints the split,
#                        its tree, the public head and its tree, the message and whether the push
#                        would fast-forward; pushes nothing
#   --push <branch>      the same against <branch>, then push the commit there (fast-forward
#                        only; a branch the public repo does not have yet is created)
#   --message <m>        the message (a file if <m> names one, else the text itself) instead of
#                        CHANGELOG.md's top entry; taken verbatim (give it its own subject)
#   --trailers           also append the two attribution lines (Co-Authored-By, Claude-Session);
#                        by default there are none: the owner publishes under his own name
#
# If the tree equals the public head's tree there is nothing to publish: the script says so
# and stops (before the check), whatever the options.
#
# The message: CHANGELOG.md (in the tree being exported, Keep a Changelog style, newest first)
# has one entry per public commit, headed `## <date or Unreleased> - <summary>`; the top entry
# becomes `solid-watch: <summary>`, a blank line and the entry's body. An export whose top entry
# is the one the public head already carries (its subject equals the public head's subject) is
# refused: write the entry for this export first, or pass --message. Every message ends with
# `Exported from the esensible monorepo (projects/solid-watch at <sha>, tree <tree>).`
#
# The check: the split (`git subtree split`, whose tree is the exported tree: the script checks
# that) is checked out (git worktree add --detach) into a temporary directory outside the
# monorepo, where nothing of the monorepo is visible; there `git submodule update --init`
# fetches quickjs-ng (declared by projects/solid-watch/.gitmodules, the tree's own: the
# monorepo's root .gitmodules is not in it), `test/build-qjs.sh` builds qjs from it, and then
# `npm ci` and `CHECK_CLEAN=1 sh test/all.sh` (codegen, the test bundles, the fixtures
# regenerated under qjs and node and unchanged against the tree, the node tests, the types, the
# boundary, the examples) must pass. The temporary worktree, its node_modules and qjs are
# removed afterwards, also on failure. A tree that fails the check is not pushed.
#
# The Swift package is not built here (no Xcode in a container). Where `xcrun` is found (the
# Mac), the check also runs `sh scripts/build-quickjs-xcframework.sh` and `swift build` in the
# temporary worktree; otherwise it says so, and the Swift side is checked by hand on the Mac:
# `swift test` in projects/solid-watch (after scripts/build-quickjs-xcframework.sh), the same
# sources the tree has.
#
# Pushing is outward-facing: only with the owner's go-ahead. Never force. The commit's parent is
# the public head as fetched, so it fast-forwards unless the branch moved since (the push then
# stops: run it again) or something other than this script wrote there (the public repo is
# never edited: find out what happened first; never overwrite it).
#
# Env: SOLID_WATCH_PUBLIC, where --push pushes (default git@github.com:esensible/solid-watch.git:
# ssh, so the container needs an ssh client and the host's keys); SOLID_WATCH_PUBLIC_FETCH,
# where the public branch is read from (default https://github.com/esensible/solid-watch.git:
# the repo is public, so reading it needs no credentials); REV (default HEAD); BRANCH, the
# public branch a dry run compares with (default main; --push <branch> sets it).
# Writes refs/solid-watch-publish/{split,export,remote/*} in the repository (all cleared at the
# start of each run), and a git worktree it removes again (if the script is killed before it
# can, `git worktree prune` drops the stale entry).
set -eu

REMOTE=${SOLID_WATCH_PUBLIC:-git@github.com:esensible/solid-watch.git}
FETCH=${SOLID_WATCH_PUBLIC_FETCH:-https://github.com/esensible/solid-watch.git}
REV=${REV:-HEAD}
HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(git -C "$HERE" rev-parse --show-toplevel)
PREFIX=projects/solid-watch
REFS=refs/solid-watch-publish

usage() {
    echo "usage: $0 [--message <file-or-text>] [--trailers] [--push <branch>]" >&2
    exit 2
}

push_branch=""
message=""
message_set=no
trailers=no
while [ $# -gt 0 ]; do
    case "$1" in
        --push)
            [ $# -ge 2 ] || usage
            push_branch=$2
            shift 2
            ;;
        --message)
            [ $# -ge 2 ] || usage
            message=$2
            message_set=yes
            shift 2
            ;;
        --trailers)
            trailers=yes
            shift
            ;;
        *) usage ;;
    esac
done
BRANCH=${push_branch:-${BRANCH:-main}}

for tool in git node npm cc make; do
    if ! command -v "$tool" > /dev/null; then
        echo "publish: no $tool here: run this in a dev container that has it" >&2
        exit 1
    fi
done
case "$REMOTE" in
    https://* | file://* | /*) ;;
    *)
        if [ -n "$push_branch" ] && ! command -v ssh > /dev/null; then
            echo "publish: --push to $REMOTE needs ssh, and there is no ssh client here (the image needs openssh-client)" >&2
            exit 1
        fi
        ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/solid-watch-publish.XXXXXX")
cleanup() {
    git -C "$TOP" worktree remove --force "$WORK/solid-watch" 2> /dev/null || true
    git -C "$TOP" worktree prune
    rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for ref in $(git -C "$TOP" for-each-ref --format='%(refname)' "$REFS/"); do
    git -C "$TOP" update-ref -d "$ref"
done

SHA=$(git -C "$TOP" rev-parse --short "$REV")
echo "publish: splitting $PREFIX at $SHA (slow on first run)"
SPLIT=$(git -C "$TOP" subtree split --prefix "$PREFIX" "$REV")
git -C "$TOP" update-ref "$REFS/split" "$SPLIT"
TREE=$(git -C "$TOP" rev-parse "$SPLIT^{tree}")
if [ "$TREE" != "$(git -C "$TOP" rev-parse "$REV:$PREFIX")" ]; then
    echo "publish: refusing: the split's tree $TREE is not $PREFIX at $SHA" >&2
    exit 1
fi
echo "publish: split = $SPLIT"
echo "publish: tree  = $TREE ($PREFIX at $SHA)"

# What must not be in the tree: build outputs and the submodule's content (a gitlink only).
for path in node_modules Frameworks dist .build; do
    if git -C "$TOP" cat-file -e "$TREE:$path" 2> /dev/null; then
        echo "publish: refusing: the tree has $path/ (a build output; .gitignore)" >&2
        exit 1
    fi
done
if [ "$(git -C "$TOP" ls-tree "$TREE" quickjs-ng | cut -d' ' -f2)" != commit ]; then
    echo "publish: refusing: quickjs-ng in the tree is not a submodule pointer" >&2
    exit 1
fi

# The public branch now, fetched into refs/solid-watch-publish/remote/* (none while empty).
git -C "$TOP" fetch --quiet "$FETCH" "+refs/heads/*:$REFS/remote/*"
PUBLIC=""
if git -C "$TOP" show-ref --verify --quiet "$REFS/remote/$BRANCH"; then
    PUBLIC=$(git -C "$TOP" rev-parse "$REFS/remote/$BRANCH")
    PUBLIC_TREE=$(git -C "$TOP" rev-parse "$PUBLIC^{tree}")
    echo "publish: public $BRANCH = $PUBLIC"
    echo "publish: its tree  = $PUBLIC_TREE"
    if [ "$PUBLIC_TREE" = "$TREE" ]; then
        echo "publish: nothing to publish: public $BRANCH already has this tree"
        exit 0
    fi
else
    echo "publish: the public repo has no branch $BRANCH yet: the commit has no parent and a push creates the branch"
fi

# The message.
MSG=$WORK/message
if [ "$message_set" = yes ]; then
    if [ -f "$message" ]; then
        cat "$message" > "$MSG"
    else
        printf '%s\n' "$message" > "$MSG"
    fi
    if ! grep -q '[^[:space:]]' "$MSG"; then
        echo "publish: refusing: --message is empty" >&2
        exit 1
    fi
else
    if ! git -C "$TOP" cat-file -e "$TREE:CHANGELOG.md" 2> /dev/null; then
        echo "publish: refusing: no CHANGELOG.md in the tree, and no --message" >&2
        exit 1
    fi
    git -C "$TOP" show "$TREE:CHANGELOG.md" > "$WORK/CHANGELOG.md"
    # The top entry: its title line (without "## ") and the lines up to the next "## " line.
    awk -v head="$WORK/entry-head" '
        /^## / { if (seen) exit; seen = 1; print substr($0, 4) > head; next }
        seen { print }
    ' "$WORK/CHANGELOG.md" > "$WORK/entry-raw"
    if [ ! -f "$WORK/entry-head" ]; then
        echo "publish: refusing: CHANGELOG.md has no entry (a \"## <date or Unreleased> - <summary>\" line), and no --message" >&2
        exit 1
    fi
    title=$(cat "$WORK/entry-head")
    summary=${title#* - }
    if [ "$summary" = "$title" ] || [ -z "$summary" ]; then
        echo "publish: refusing: CHANGELOG.md's top entry \"## $title\" has no summary (head it \"## <date or Unreleased> - <summary>\")" >&2
        exit 1
    fi
    subject="solid-watch: $summary"
    if [ -n "$PUBLIC" ] && [ "$subject" = "$(git -C "$TOP" log -1 --format=%s "$PUBLIC")" ]; then
        echo "publish: refusing: CHANGELOG.md's top entry (\"$summary\") is the one public $BRANCH already carries:" >&2
        echo "publish: add an entry for this export at the top of $PREFIX/CHANGELOG.md, or pass --message" >&2
        exit 1
    fi
    # The body without its leading and trailing blank lines.
    awk 'NF { for (; n > 0; n--) print ""; print; started = 1; next } started { n++ }' \
        "$WORK/entry-raw" > "$WORK/entry-body"
    printf '%s\n' "$subject" > "$MSG"
    if [ -s "$WORK/entry-body" ]; then
        printf '\n' >> "$MSG"
        cat "$WORK/entry-body" >> "$MSG"
    fi
fi
printf '\nExported from the esensible monorepo (%s at %s, tree %s).\n' "$PREFIX" "$SHA" "$TREE" >> "$MSG"
if [ "$trailers" = yes ]; then
    printf '\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01NfXPZrUmD82ChkZXqeaMyM\n' >> "$MSG"
fi
echo "publish: author = $(git -C "$TOP" config user.name) <$(git -C "$TOP" config user.email)>"
echo "publish: message:"
sed 's/^/  | /' "$MSG"

# The tree on its own: a checkout of it outside the monorepo must pass the whole suite.
git -C "$TOP" worktree add --detach --quiet "$WORK/solid-watch" "$SPLIT"
git -C "$WORK/solid-watch" submodule update --init
echo "publish: checking the tree in $WORK/solid-watch"
(cd "$WORK/solid-watch" && sh test/build-qjs.sh "$WORK/solid-watch/quickjs-ng" "$WORK/qjs")
(cd "$WORK/solid-watch" && npm ci --no-audit --no-fund)
(cd "$WORK/solid-watch" && QJS="$WORK/qjs" CHECK_CLEAN=1 sh test/all.sh)
swift_checked=no
if command -v xcrun > /dev/null; then
    (cd "$WORK/solid-watch" && sh scripts/build-quickjs-xcframework.sh && swift build)
    swift_checked=yes
fi
git -C "$TOP" worktree remove --force "$WORK/solid-watch"
echo "publish: the tree passes on its own (npm ci, test/all.sh with CHECK_CLEAN=1)"
if [ "$swift_checked" = yes ]; then
    echo "publish: and the Swift package builds (swift build)"
else
    echo "publish: no Xcode here: the Swift package was not built (on the Mac: swift test in $PREFIX)"
fi

# The one commit: the tree on top of the public head.
if [ -n "$PUBLIC" ]; then
    COMMIT=$(git -C "$TOP" commit-tree "$TREE" -p "$PUBLIC" -F "$MSG")
else
    COMMIT=$(git -C "$TOP" commit-tree "$TREE" -F "$MSG")
fi
git -C "$TOP" update-ref "$REFS/export" "$COMMIT"
echo "publish: commit = $COMMIT (parent ${PUBLIC:-none})"
if [ -n "$PUBLIC" ]; then
    if git -C "$TOP" merge-base --is-ancestor "$PUBLIC" "$COMMIT"; then
        echo "publish: the push would fast-forward public $BRANCH by 1 commit"
    else
        echo "publish: refusing: public $BRANCH ($PUBLIC) is not an ancestor of $COMMIT, so the push would not fast-forward; never force" >&2
        exit 1
    fi
else
    echo "publish: the push would create public $BRANCH with this one commit"
fi

if [ -z "$push_branch" ]; then
    echo "publish: nothing pushed (dry run); to export: $0 --push $BRANCH"
    exit 0
fi

# The branch must still be where the commit's parent says (fetch again: it is cheap).
now=$(git -C "$TOP" ls-remote "$FETCH" "refs/heads/$BRANCH" | cut -f1)
if [ "$now" != "$PUBLIC" ]; then
    echo "publish: refusing: public $BRANCH moved from ${PUBLIC:-nothing} to ${now:-nothing} since it was fetched: run this again" >&2
    exit 1
fi
git -C "$TOP" push "$REMOTE" "$COMMIT:refs/heads/$BRANCH"
echo "publish: pushed $COMMIT to $REMOTE $BRANCH"
