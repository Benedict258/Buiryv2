#!/usr/bin/env bash
# Swap file for the 1 core, 1 GB profile (docs/DEPLOY_ORACLE.md, 1 GB profile). DESIGNED ONLY: not run on Oracle.
# Run once with sudo. Creates /swapfile (2 GB) only if no swap is active, makes it permanent, and lowers swappiness so
# swap is a buffer for spikes, not working memory. Changes nothing else.
set -euo pipefail

SWAP_FILE=/swapfile
SWAP_SIZE_MB=2048

if [ -n "$(swapon --noheadings --show=NAME)" ]; then
  echo "[swap] swap already active; nothing changed"
  swapon --show
  exit 0
fi
fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE" || dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none
chmod 600 "$SWAP_FILE"
mkswap "$SWAP_FILE" >/dev/null
swapon "$SWAP_FILE"
grep -qF "$SWAP_FILE none swap" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-buiry-swap.conf
sysctl -q -p /etc/sysctl.d/90-buiry-swap.conf
echo "[swap] ${SWAP_SIZE_MB} MB swap active; swappiness 10"
swapon --show
