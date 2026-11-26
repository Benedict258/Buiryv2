#!/usr/bin/env bash
# Builds the deployable artefact OFF the VM (docs/DEPLOY_ORACLE.md, 1 GB profile). DESIGNED ONLY: not run on Oracle.
# Run from the repository root on the build machine, never on the 1 GB VM. Produces, in OUT_DIR:
#   buiry-<commit>.tar.gz          production dependencies only (pnpm deploy --prod), the built server, protos, the
#                                  preview dashboard, the lockfile, the ops scripts and a manifest
#   buiry-<commit>.tar.gz.sha256   its checksum (verify on the VM with: sha256sum -c buiry-<commit>.tar.gz.sha256)
# The production dependencies are pure JavaScript and WebAssembly (no native modules, checked in Phase 16b), so one
# artefact serves both x86_64 and arm64. No env file is ever included: the build stops if one is found.
set -euo pipefail

OUT_DIR="${OUT_DIR:-$(pwd)/.artifact}"
PNPM="${PNPM:-corepack pnpm}"

if [ -n "$(git status --porcelain)" ]; then
  echo "[artifact] the working tree is not clean; commit or stash first" >&2
  exit 2
fi
COMMIT="$(git rev-parse --short HEAD)"
STAGE="$OUT_DIR/stage-$COMMIT"
APP="$STAGE/app"
rm -rf "$STAGE"
mkdir -p "$OUT_DIR"

$PNPM install --frozen-lockfile
VITE_BUIRY_PREVIEW=1 $PNPM --filter @buiry/dashboard exec vite build
$PNPM --filter @buiry/worker run build:server
# Production dependencies only: no devDependencies, hoisted like the image.
$PNPM --filter @buiry/worker deploy --prod --legacy --config.node-linker=hoisted "$APP"
cp -r packages/worker/dist-server "$APP/dist-server"
cp -r packages/chain/proto "$APP/proto"
cp -r apps/dashboard/dist "$APP/dashboard"
cp pnpm-lock.yaml "$APP/pnpm-lock.yaml"
rm -rf "$APP/src"
# Ops files the VM needs without a source checkout: backup and restore, and the Oracle templates.
mkdir -p "$APP/ops/scripts/backup" "$APP/ops/infra/oracle"
cp scripts/backup/backup.sh scripts/backup/restore.sh scripts/backup/lib.sh "$APP/ops/scripts/backup/"
cp infra/oracle/* "$APP/ops/infra/oracle/"

# Never ship an env file or a key.
if find "$APP" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \) -print -quit | grep -q .; then
  echo "[artifact] an env file or key was found in the artefact; refusing" >&2
  exit 3
fi
# No workspace dev tool unless a production package requires it (typescript is a peer of production packages).
node "$(dirname "$0")/check-artifact-deps.cjs" "$APP"

{
  echo "commit=$COMMIT"
  echo "built_with_node=$(node --version)"
  echo "files=$(find "$APP" -type f | wc -l | tr -d ' ')"
} > "$APP/MANIFEST"

TAR="buiry-$COMMIT.tar.gz"
tar -czf "$OUT_DIR/$TAR" -C "$STAGE" app
(cd "$OUT_DIR" && sha256sum "$TAR" > "$TAR.sha256")
rm -rf "$STAGE"
echo "[artifact] $OUT_DIR/$TAR"
cat "$OUT_DIR/$TAR.sha256"
