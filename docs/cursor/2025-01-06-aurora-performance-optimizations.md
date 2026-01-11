# Aurora Performance Optimizations - January 6, 2025

## Summary

Performance optimizations applied to Aurora PostgreSQL to improve brand presence query response times.

### Results

| Endpoint | Before | After | Improvement |
|----------|--------|-------|-------------|
| `/stats` (stat cards) | ~10s | ~3.5s | ~3x faster |
| `/topics` | ~10-11s | ~500ms | ~20x faster |

---

## 1. Increased `work_mem` Setting

**Problem**: Queries were spilling sorts to disk (external merge sort) due to insufficient memory.

**Solution**: Increased `work_mem` from 64MB to 256MB at the database level.

```sql
-- Check current setting
SHOW work_mem;
-- Result: 64MB

-- Set at database level (permanent for all new connections)
ALTER DATABASE spacecatdb SET work_mem = '256MB';

-- Verify (requires new connection)
SHOW work_mem;
-- Result: 256MB
```

**Impact**: Reduced `/stats` endpoint from ~10s to ~3.5s by keeping sort operations in memory.

---

## 2. Added `sources_count` to Materialized View

**Problem**: The `/topics` endpoint was joining `brand_presence` (3.6M rows) with `brand_presence_sources` (24M rows) at query time to count distinct URLs, taking ~10 seconds.

**Solution**: Pre-compute `sources_count` in the `brand_presence_topics_by_date` materialized view.

### Step 1: Drop existing view

```sql
DROP MATERIALIZED VIEW IF EXISTS brand_presence_topics_by_date CASCADE;
```

### Step 2: Create new view with `sources_count` column

```sql
CREATE MATERIALIZED VIEW brand_presence_topics_by_date AS
SELECT
  bp.site_id,
  bp.model,
  bp.date,
  bp.category,
  bp.topics,
  bp.region,
  bp.origin,
  
  -- Execution count
  COUNT(*) AS executions_count,
  
  -- Mentions: count where mentions = true
  COUNT(*) FILTER (WHERE bp.mentions = TRUE) AS mentions_count,
  
  -- Citations: count of executions with at least one owned source
  COUNT(DISTINCT CASE WHEN owned_sources.brand_presence_id IS NOT NULL THEN bp.id END) AS citations_count,
  
  -- Sources: count of distinct URLs (NEW COLUMN)
  COUNT(DISTINCT all_sources.url) AS sources_count,
  
  -- Visibility Score: average (NULLs treated as 0)
  ROUND(AVG(COALESCE(bp.visibility_score, 0)), 2) AS avg_visibility_score,
  
  -- Position: average (excluding non-numeric values)
  ROUND(
    AVG(
      CASE
        WHEN bp.position IS NOT NULL
          AND bp.position != ''
          AND bp.position != 'Not Mentioned'
          AND bp.position ~ '^[0-9]+\.?[0-9]*$'
        THEN bp.position::NUMERIC
        ELSE NULL
      END
    ),
    2
  ) AS avg_position,
  
  -- Sentiment counts
  COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'positive') AS sentiment_positive,
  COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'neutral') AS sentiment_neutral,
  COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'negative') AS sentiment_negative,
  
  -- Volume for popularity
  ROUND(AVG(bp.volume), 2) AS avg_volume
  
FROM brand_presence bp
LEFT JOIN (
  SELECT DISTINCT brand_presence_id
  FROM brand_presence_sources
  WHERE content_type = 'owned'
) owned_sources ON bp.id = owned_sources.brand_presence_id
LEFT JOIN brand_presence_sources all_sources ON bp.id = all_sources.brand_presence_id
GROUP BY bp.site_id, bp.model, bp.date, bp.category, bp.topics, bp.region, bp.origin;
```

### Step 3: Recreate indexes

```sql
CREATE INDEX idx_topics_site_model_date ON brand_presence_topics_by_date(site_id, model, date);
CREATE INDEX idx_topics_category ON brand_presence_topics_by_date(category);
CREATE INDEX idx_topics_topics ON brand_presence_topics_by_date(topics);
CREATE INDEX idx_topics_region ON brand_presence_topics_by_date(region);
CREATE INDEX idx_topics_origin ON brand_presence_topics_by_date(origin);
CREATE UNIQUE INDEX idx_topics_unique ON brand_presence_topics_by_date(site_id, model, date, category, topics, region, origin);
```

### Step 4: Analyze for query planner

```sql
ANALYZE brand_presence_topics_by_date;
```

**Build time**: ~2 minutes

**Impact**: Reduced `/topics` endpoint from ~10-11s to ~500ms by eliminating runtime JOIN.

---

## Code Changes

Updated `src/controllers/llmo/brand-presence/data-insights.js`:
- Removed `source_counts` CTE that performed expensive JOIN
- Now uses `SUM(sources_count)` from the pre-computed view column

---

## Refresh Considerations

The `sources_count` column is computed when the materialized view is refreshed. Ensure the view refresh process (`refresh_brand_presence_views()`) is run after data imports to keep source counts current.

```sql
-- Refresh the view (run after data imports)
REFRESH MATERIALIZED VIEW CONCURRENTLY brand_presence_topics_by_date;
```

