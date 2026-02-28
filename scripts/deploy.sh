#!/usr/bin/env bash
set -euo pipefail

DROPLET_IP="${1:-${DROPLET_IP:-}}"
REMOTE_DIR="/root/monke-army"
REMOTE_USER="root"

if [ -z "$DROPLET_IP" ]; then
    echo "Usage: ./scripts/deploy.sh <DROPLET_IP>"
    echo "   or: DROPLET_IP=1.2.3.4 ./scripts/deploy.sh"
    exit 1
fi

REMOTE="$REMOTE_USER@$DROPLET_IP"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Syncing code to $REMOTE:$REMOTE_DIR"
rsync -avz --delete \
    --exclude 'node_modules/' \
    --exclude '.env' \
    --exclude '*.env' \
    --exclude '.env.example' \
    --exclude 'target/' \
    --exclude 'ref/' \
    --exclude '.git/' \
    --exclude '.vercel/' \
    --exclude 'positions-cache.json' \
    --exclude '.DS_Store' \
    --exclude 'claude.md' \
    "$PROJECT_ROOT/" "$REMOTE:$REMOTE_DIR/"

echo "==> Installing dependencies and restarting bot"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --omit=dev && pm2 restart monke-harvester"

echo "==> Waiting for bot to come up..."
sleep 3

echo "==> Health check"
HEALTH=$(ssh "$REMOTE" "curl -sf http://localhost:8080/api/stats || echo 'FAILED'")
echo "$HEALTH"

if [ "$HEALTH" = "FAILED" ]; then
    echo ""
    echo "WARNING: Health check failed. Check logs with:"
    echo "  ssh $REMOTE 'pm2 logs monke-harvester --lines 50'"
    exit 1
fi

echo ""
echo "==> Deploy complete!"
