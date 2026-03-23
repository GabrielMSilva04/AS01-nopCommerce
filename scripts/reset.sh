#!/usr/bin/env bash
# reset.sh — wipe all volumes and restore a clean configured nopCommerce state.
# Requires scripts/nopcommerce.bak to exist (run snapshot.sh once first).
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$SCRIPT_DIR/nopcommerce.bak" ]; then
  echo "✗ No snapshot found at scripts/nopcommerce.bak"
  echo "  Set up the store wizard first, then run: scripts/snapshot.sh"
  exit 1
fi

cd "$ROOT"

echo "→ Tearing down stack and removing all volumes..."
docker compose down -v

echo "→ Starting database only..."
docker compose up -d nopcommerce_database

echo "→ Waiting for SQL Server to be healthy..."
until docker exec nopcommerce_mssql_server \
  /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "nopCommerce_db_password" -No \
  -Q "SELECT 1" &>/dev/null 2>&1; do
  sleep 2
done
echo "   SQL Server ready."

echo "→ Restoring database..."
docker cp "$SCRIPT_DIR/nopcommerce.bak" nopcommerce_mssql_server:/var/opt/mssql/backup/nopcommerce.bak
docker exec nopcommerce_mssql_server \
  /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "nopCommerce_db_password" -No \
  -Q "RESTORE DATABASE nopCommerce FROM DISK = '/var/opt/mssql/backup/nopcommerce.bak' WITH REPLACE, MOVE 'nopCommerce' TO '/var/opt/mssql/data/nopCommerce.mdf', MOVE 'nopCommerce_log' TO '/var/opt/mssql/data/nopCommerce_log.ldf'"
echo "   Database restored."

echo "→ Starting full stack..."
docker compose up -d

echo ""
echo "✓ Ready. Store at http://localhost  |  Grafana at http://localhost:3000"
