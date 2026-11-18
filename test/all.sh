#!/bin/sh
# Everything CI runs for solid-watch, from the package root:
#   QJS=/path/to/qjs test/all.sh
# codegen up to date, test bundles rebuilt, fixtures regenerated (qjs and
# node must agree), fixtures unchanged vs git when CHECK_CLEAN=1, unit tests,
# import boundary, the examples (installed fresh: their solid-watch is a copy
# of this package's files, taken at install), built and run.
set -eu
cd "$(dirname "$0")/.."
node codegen/codegen.mjs --check
npx rollup -c test/rollup.config.js --silent
node test/make-fixtures.mjs --qjs "${QJS:-qjs}"
node test/make-layout-fixtures.mjs
if [ "${CHECK_CLEAN:-0}" = 1 ]; then
  git diff --exit-code -- fixtures
fi
node --test --test-reporter=spec test/*.test.mjs
node codegen/codegen.mjs --fragment test/demo-fragment.json --ts test/types/demo-jsx.d.ts
npx tsc -p test/types
npx tsc -p test/types/tsconfig.fragment.json
echo "types ok"
node test/boundary.mjs
(cd Examples/bundles && npm ci --no-audit --no-fund --loglevel=error && QJS="${QJS:-qjs}" npm test --silent)
