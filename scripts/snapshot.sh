#!/usr/bin/env bash
# snapshot.sh — dump the live nopCommerce database to scripts/nopcommerce.bak
# Run this once after completing the store setup wizard.
# The saved backup is used by reset.sh to restore a clean configured state.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Creating backup inside the SQL Server container..."
docker exec nopcommerce_mssql_server mkdir -p /var/opt/mssql/backup
docker exec nopcommerce_mssql_server \
  /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "nopCommerce_db_password" -No \
  -Q "BACKUP DATABASE nopCommerce TO DISK = '/var/opt/mssql/backup/nopcommerce.bak' WITH FORMAT, INIT"

echo "→ Copying backup to scripts/nopcommerce.bak..."
docker cp nopcommerce_mssql_server:/var/opt/mssql/backup/nopcommerce.bak "$SCRIPT_DIR/nopcommerce.bak"

echo "✓ Snapshot saved. Run scripts/reset.sh to restore it at any time."
