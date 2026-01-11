ALTER DATABASE spacecatdb SET work_mem = '64MB';

-- Vacuum and analyze tables
VACUUM ANALYZE brand_presence;
VACUUM ANALYZE brand_presence_sources;
VACUUM ANALYZE brand_vs_competitors;

-- Reindex tables
REINDEX TABLE brand_presence;
REINDEX TABLE brand_presence_sources;
REINDEX TABLE brand_vs_competitors;

-- Refresh materialized views
REFRESH MATERIALIZED VIEW brand_presence_topics_by_date;
REFRESH MATERIALIZED VIEW brand_presence_prompts_by_date;

-- Analyze materialized views
VACUUM ANALYZE brand_presence_topics_by_date;
VACUUM ANALYZE brand_presence_prompts_by_date;


-- Warm up buffer cache
SELECT COUNT(*) as topics_count FROM brand_presence_topics_by_date;
SELECT COUNT(*) as prompts_count FROM brand_presence_prompts_by_date;
SELECT COUNT(*) as brand_presence_count FROM brand_presence;
SELECT COUNT(*) as sources_count FROM brand_presence_sources;
SELECT
  topics,
  SUM(executions_count) AS executions,
  SUM(mentions_count) AS mentions
FROM brand_presence_topics_by_date
GROUP BY topics
ORDER BY mentions DESC
LIMIT 5;

SELECT
  relname as table_name,
  n_live_tup as row_count,
  last_vacuum,
  last_analyze,
  CASE
    WHEN last_analyze IS NOT NULL THEN '✅ Analyzed'
    ELSE '❌ NOT Analyzed'
  END as status
FROM pg_stat_user_tables
WHERE relname IN (
  'brand_presence',
  'brand_presence_sources',
  'brand_vs_competitors',
  'brand_presence_topics_by_date',
  'brand_presence_prompts_by_date'
)
ORDER BY relname;
