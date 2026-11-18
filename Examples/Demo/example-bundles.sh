#!/bin/sh
# Build phase "Example bundles" of SolidWatchDemo.xcodeproj: copies each built
# example (Examples/bundles/dist/<name>/bundle.js, from `npm run build` there)
# into the app as Examples/<name>/, where the demo lists them. Built examples
# are not in git, so with none built the app has no Examples folder and the
# demo runs the fixtures only.
set -eu
DIST="$SRCROOT/../bundles/dist"
OUT="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Examples"
rm -rf "$OUT"
[ -d "$DIST" ] || { echo "example-bundles: no $DIST (run npm run build in Examples/bundles to include the examples)"; exit 0; }
for d in "$DIST"/*/; do
    name=$(basename "$d")
    [ -f "$d/bundle.js" ] || continue
    mkdir -p "$OUT/$name"
    cp "$d/bundle.js" "$OUT/$name/bundle.js"
    [ ! -f "$d/script.json" ] || cp "$d/script.json" "$OUT/$name/script.json"
    echo "example-bundles: $name"
done
