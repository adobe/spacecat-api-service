#!/bin/bash

# Export database from local PostgreSQL container
# This creates a SQL dump that can be imported to Aurora

set -e

CONTAINER_NAME="spacecat-postgres-local"
DB_NAME="spacecatdb"
DB_USER="spacecatuser"
BACKUP_FILE="spacecat-aurora-backup-$(date +%Y%m%d-%H%M%S).sql"

echo "📦 Exporting database from local PostgreSQL..."
echo ""

# Check if container is running
if ! docker ps | grep -q "$CONTAINER_NAME"; then
    echo "❌ Error: Container '$CONTAINER_NAME' is not running!"
    echo "   Start it with: npm run db:up"
    exit 1
fi

echo "🔄 Creating SQL dump..."
docker exec "$CONTAINER_NAME" pg_dump \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --clean \
    --if-exists \
    --no-owner \
    --no-acl > "$BACKUP_FILE"

echo ""
echo "✅ Export complete!"
echo ""
echo "📄 Backup file: $BACKUP_FILE"
echo "📊 File size: $(du -h "$BACKUP_FILE" | cut -f1)"
echo ""
echo "🎯 Next steps:"
echo "   1. Review the backup file"
echo "   2. Import to Aurora: ./scripts/import-to-aurora.sh $BACKUP_FILE"
echo ""
