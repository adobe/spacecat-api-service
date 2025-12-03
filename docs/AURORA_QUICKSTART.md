# Quick Start: Aurora PostgreSQL Setup

## ?? Get Started in 5 Minutes

### 1. Install Dependencies

```bash
npm install
```

This installs the `pg` PostgreSQL client library.

### 2. Start Database

```bash
npm run db:up
```

This starts PostgreSQL in Docker on port 5432.

### 3. Start the API

```bash
npm start
```

### 4. Test Database Connectivity

```bash
# Use the LLMO Athena endpoint to test
curl -H "x-api-key: your_api_key" \
     http://localhost:3000/api/v1/llmo/site-demo-001/athena
```

Look for the `database` section in the response showing connection status and query results.

---

## ?? What Was Created

```
spacecat-api-service/
??? docker-compose.yml              # PostgreSQL + pgAdmin containers
??? src/
?   ??? support/
?       ??? aurora-client.js        # Database client wrapper
??? docs/
    ??? AURORA_WORKFLOW.md          # Complete documentation
```

---

## ??? Database Schema

**Schema**: `spacecat`

**Tables**:
- `sites` - Site information
- `audits` - Audit history
- `audit_metrics` - Detailed metrics
- `site_top_pages` - Top pages data
- `opportunities` - Improvement opportunities

---

## ?? Common Commands

```bash
# Database management
npm run db:up          # Start database
npm run db:down        # Stop database

# Development
npm start              # Start API with hot reload
npm test               # Run tests
npm run lint:fix       # Fix linting issues
```

---

## ?? Access Database Directly

### Option 1: pgAdmin (Web UI)
1. Open: http://localhost:5050
2. Login: `admin@example.com` / `admin`
3. Add Server:
   - Name: `SpaceCat Local`
   - Host: **`postgres`** (not localhost!)
   - Port: `5432`
   - Database: `spacecatdb`
   - User: `spacecatuser`
   - Password: `spacecatpassword`
   - Save password: ?
4. Navigate: Servers ? SpaceCat Local ? Databases ? spacecatdb ? Schemas ? spacecat ? Tables

### Option 2: psql CLI
```bash
docker exec -it spacecat-postgres-local psql -U spacecatuser -d spacecatdb
```

---

## ?? Environment Variables

Required in `.env`:

```bash
# PostgreSQL (Local)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=spacecatdb
POSTGRES_USER=spacecatuser
POSTGRES_PASSWORD=spacecatpassword

# Enable queries
ENABLE_AURORA_QUERIES=true
```

For Aurora (Production):
```bash
AURORA_HOST=your-cluster.region.rds.amazonaws.com
AURORA_PORT=5432
AURORA_DATABASE=spacecatdb
AURORA_USER=admin
AURORA_PASSWORD=secure_password
AURORA_SSL=true
```

---

---

## ?? Testing

### Run Database Tests
```bash
npm test -- test/support/aurora-client.test.js
```

### Test via API Endpoint
The LLMO Athena endpoint (`GET /api/v1/llmo/:siteId/athena`) now includes database connectivity tests:

```json
{
  "database": {
    "connected": true,
    "siteExists": true,
    "totalAudits": 155,
    "auditsByType": [...],
    "poolStats": {
      "totalCount": 1,
      "idleCount": 1,
      "waitingCount": 0
    }
  }
}
```

---

## ?? Full Documentation

See [docs/AURORA_WORKFLOW.md](./AURORA_WORKFLOW.md) for:
- Complete architecture overview
- Production deployment guide
- Query optimization tips
- Troubleshooting guide
- Best practices

---

## ?? Troubleshooting

### Port already in use
```bash
lsof -i :5432
brew services stop postgresql  # If using local PostgreSQL
npm run db:reset
```

### Can't connect to database
```bash
docker logs spacecat-postgres-local
npm run db:reset
```

### Need to reset everything
```bash
docker-compose down -v  # Remove volumes
npm run db:up
npm run db:migrate
npm run db:seed
```

---

## ?? Next Steps

1. **Create your database schema** as needed

2. **Create your first query**
   - Add queries to existing controllers
   - Use `context.aurora.query()` or `context.aurora.queryOne()`

3. **Read the full documentation**
   - Check out [AURORA_WORKFLOW.md](./AURORA_WORKFLOW.md)

---

## ? Verification Checklist

- [ ] Docker is running
- [ ] Database container is healthy (`docker ps`)
- [ ] Can access pgAdmin at http://localhost:5050
- [ ] API server starts without errors
- [ ] Test endpoint returns database connection info

---

## ?? Need Help?

1. Check logs: `docker logs spacecat-postgres-local`
2. Review [AURORA_WORKFLOW.md](./AURORA_WORKFLOW.md)
3. Run tests: `npm test -- test/support/aurora-client.test.js`
4. Check database: `docker exec -it spacecat-postgres-local psql -U spacecatuser -d spacecatdb -c "SELECT version();"`

Happy coding! ??

