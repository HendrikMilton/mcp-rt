#!/usr/bin/env bash
# Builds lambda.zip: compiled app + production deps.
set -euo pipefail
cd "$(dirname "$0")/.."

yarn build

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp -r dist "$STAGE/dist"
cp package.json yarn.lock "$STAGE/"
(cd "$STAGE" && yarn install --production --frozen-lockfile --ignore-scripts >/dev/null)

rm -f lambda.zip
(cd "$STAGE" && zip -qr "$OLDPWD/lambda.zip" dist node_modules package.json)
echo "lambda.zip: $(du -h lambda.zip | cut -f1)"
