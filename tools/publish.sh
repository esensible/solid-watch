#!/bin/sh
# tools/publish.sh — export projects/solid-watch to its public repo, github.com/esensible/solid-watch.
#
# The esensible monorepo is the source of truth; the public repo is a publication target fed
# by `git subtree split`: the history of projects/solid-watch as a standalone repository
# (projects/solid-watch/ becomes its root). The public repo's history is the split's, so every
# export fast-forwards the public branch it was taken from. Nothing is ever edited there.
#
# Run it from projects/solid-watch in a monorepo dev container that has git, node (>= 20), npm,
# a C compiler and make (for qjs) and ssh (for a push), and that mounts the whole repository
# (at /workspace) and the host's ~/.ssh. E.g. from the monorepo root:
# .devcontainer/dc exec <container> -- sh /workspace/projects/solid-watch/tools/publish.sh
#
#   sh tools/publish.sh                   split HEAD, check the split stands alone (below), show
#                                         what an export would push (and whether it
#                                         fast-forwards each public branch); pushes nothing
#   sh tools/publish.sh --push <branch>   the same, then push the split to <branch> of the
#                                         public repo (fast-forward only; a branch the public
#                                         repo does not have yet is created)
#
# The check: the split commit is checked out (git worktree add --detach) into a temporary
# directory outside the monorepo, where nothing of the monorepo is visible; there
# `git submodule update --init` fetches quickjs-ng (declared by projects/solid-watch/.gitmodules,
# the split's own: the monorepo's root .gitmodules is not in the split), `test/build-qjs.sh`
# builds qjs from it, and then `npm ci` and `CHECK_CLEAN=1 sh test/all.sh` (codegen, the test
# bundles, the fixtures regenerated under qjs and node and unchanged against the split, the
# node tests, the types, the boundary) must pass. The temporary worktree, its node_modules and
# qjs are removed afterwards, also on failure. A split that fails the check is not pushed.
#
# The Swift package is not built here (no Xcode in a container). Where `xcrun` is found (the
# Mac), the check also runs `sh scripts/build-quickjs-xcframework.sh` and `swift build` in the
# temporary worktree; otherwise it says so, and the Swift side is checked by hand on the Mac:
# `swift test` in projects/solid-watch (after scripts/build-quickjs-xcframework.sh), the same
# sources the split has.
#
# Pushing is outward-facing: only with the owner's go-ahead. Never force: a branch that does
# not fast-forward means the public repo has commits the monorepo lacks; take them in first
# (git subtree pull --prefix projects/solid-watch <remote> <branch>).
#
# Env: SOLID_WATCH_PUBLIC, where --push pushes (default git@github.com:esensible/solid-watch.git:
# ssh, so the container needs an ssh client and the host's keys); SOLID_WATCH_PUBLIC_FETCH,
# where the public branches are read from (default https://github.com/esensible/solid-watch.git:
# the repo is public, so reading it needs no credentials); REV (default HEAD).
# Writes refs/solid-watch-publish/* in the repository, and a git worktree it removes again (if
# the script is killed before it can, `git worktree prune` drops the stale entry).
set -eu

REMOTE=${SOLID_WATCH_PUBLIC:-git@github.com:esensible/solid-watch.git}
FETCH=${SOLID_WATCH_PUBLIC_FETCH:-https://github.com/esensible/solid-watch.git}
REV=${REV:-HEAD}
HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(git -C "$HERE" rev-parse --show-toplevel)
PREFIX=projects/solid-watch

push_branch=""
case "${1:-}" in
    "") ;;
    --push)
        push_branch=${2:?--push needs a branch name}
        ;;
    *) echo "usage: $0 [--push <branch>]" >&2; exit 2 ;;
esac

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

echo "publish: splitting $PREFIX at $(git -C "$TOP" rev-parse --short "$REV") (slow on first run)"
SPLIT=$(git -C "$TOP" subtree split --prefix "$PREFIX" "$REV")
git -C "$TOP" update-ref refs/solid-watch-publish/split "$SPLIT"
echo "publish: split = $SPLIT"
git -C "$TOP" log --oneline -8 "$SPLIT"

# What must not be in the split: build outputs and the submodule's content (a gitlink only).
for path in node_modules Frameworks dist .build; do
    if git -C "$TOP" cat-file -e "$SPLIT:$path" 2> /dev/null; then
        echo "publish: refusing: the split has $path/ (a build output; .gitignore)" >&2
        exit 1
    fi
done
if [ "$(git -C "$TOP" ls-tree "$SPLIT" quickjs-ng | cut -d' ' -f2)" != commit ]; then
    echo "publish: refusing: quickjs-ng in the split is not a submodule pointer" >&2
    exit 1
fi

# The split on its own: a checkout of it outside the monorepo must pass the whole suite.
CHECK=$(mktemp -d "${TMPDIR:-/tmp}/solid-watch-publish.XXXXXX")
cleanup() {
    git -C "$TOP" worktree remove --force "$CHECK/solid-watch" 2> /dev/null || true
    git -C "$TOP" worktree prune
    rm -rf "$CHECK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
git -C "$TOP" worktree add --detach --quiet "$CHECK/solid-watch" "$SPLIT"
git -C "$CHECK/solid-watch" submodule update --init
echo "publish: checking the split in $CHECK/solid-watch"
(cd "$CHECK/solid-watch" && sh test/build-qjs.sh "$CHECK/solid-watch/quickjs-ng" "$CHECK/qjs")
(cd "$CHECK/solid-watch" && npm ci --no-audit --no-fund)
(cd "$CHECK/solid-watch" && QJS="$CHECK/qjs" CHECK_CLEAN=1 sh test/all.sh)
swift_checked=no
if command -v xcrun > /dev/null; then
    (cd "$CHECK/solid-watch" && sh scripts/build-quickjs-xcframework.sh && swift build)
    swift_checked=yes
fi
cleanup
trap - EXIT INT TERM
echo "publish: the split passes on its own (npm ci, test/all.sh with CHECK_CLEAN=1)"
if [ "$swift_checked" = yes ]; then
    echo "publish: and the Swift package builds (swift build)"
else
    echo "publish: no Xcode here: the Swift package was not built (on the Mac: swift test in $PREFIX)"
fi

# What the public repo has now, fetched into refs/solid-watch-publish/remote/* (none while empty).
for ref in $(git -C "$TOP" for-each-ref --format='%(refname)' refs/solid-watch-publish/remote/); do
    git -C "$TOP" update-ref -d "$ref"
done
git -C "$TOP" fetch --quiet "$FETCH" "+refs/heads/*:refs/solid-watch-publish/remote/*"
found=0
for b in $(git -C "$TOP" for-each-ref --format='%(refname:strip=3)' refs/solid-watch-publish/remote/); do
    found=1
    if git -C "$TOP" merge-base --is-ancestor "refs/solid-watch-publish/remote/$b" "$SPLIT"; then
        n=$(git -C "$TOP" rev-list --count "refs/solid-watch-publish/remote/$b..$SPLIT")
        echo "publish: $b fast-forwards by $n commit(s)"
    else
        echo "publish: $b does NOT fast-forward (it has commits the split lacks)"
    fi
done
[ "$found" = 1 ] || echo "publish: the public repo has no branches yet: a push creates the branch"

if [ -z "$push_branch" ]; then
    echo "publish: nothing pushed (dry run); to export: $0 --push <branch>"
    exit 0
fi

if git -C "$TOP" show-ref --verify --quiet "refs/solid-watch-publish/remote/$push_branch" \
    && ! git -C "$TOP" merge-base --is-ancestor "refs/solid-watch-publish/remote/$push_branch" "$SPLIT"; then
    echo "publish: refusing: $push_branch on $REMOTE does not fast-forward to $SPLIT" >&2
    exit 1
fi
git -C "$TOP" push "$REMOTE" "$SPLIT:refs/heads/$push_branch"
echo "publish: pushed $SPLIT to $REMOTE $push_branch"
