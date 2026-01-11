#!/usr/bin/env node

/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { AuroraClient } from '../src/support/aurora-client.js';

/**
 * Helper to format duration in human-readable format
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(2);
  return `${minutes}m ${seconds}s`;
}

/**
 * Helper to execute a query with timing and logging
 */
async function executeWithLogging(auroraClient, sql, description) {
  const startTime = Date.now();
  console.log(`   ⏳ ${description}...`);
  await auroraClient.query(sql);
  const duration = Date.now() - startTime;
  console.log(`   ✅ ${description} (${formatDuration(duration)})`);
  return duration;
}

/**
 * Creates the Data Insights views for Brand Presence.
 *
 * Architecture:
 * 1. brand_presence_topics_by_date (Materialized View)
 *    - Grouped by: site_id, model, date, category, topics, region, origin
 *    - Pre-calculated metrics for fast topic-level queries
 *    - Refresh daily after data import
 *
 * 2. brand_presence_prompts_by_date (Materialized View)
 *    - Grouped by: site_id, model, date, category, topics, prompt, region, origin
 *    - Pre-calculated metrics for fast prompt-level queries
 *    - Refresh daily after data import
 *
 * Query Flow:
 * - Topic list: Query topics view with filters, GROUP BY topics
 * - Prompt count: Query prompts view with filters, COUNT DISTINCT
 * - Expand topic: Query prompts view filtered to one topic
 *
 * Performance Note:
 * Both views are materialized to avoid expensive real-time aggregations
 * on large tables (brand_presence: ~3.6M rows, brand_presence_sources: ~24M rows)
 */
async function createBrandPresenceViews() {
  const scriptStartTime = Date.now();
  const stepDurations = {};

  console.log('🚀 Creating Brand Presence Data Insights Views...\n');

  const auroraClient = new AuroraClient({
    host: 'localhost',
    port: 5432,
    database: 'spacecatdb',
    user: 'spacecatuser',
    password: 'spacecatpassword',
    ssl: false,
  });

  try {
    console.log('🔌 Testing database connection...');
    const connectStart = Date.now();
    const connected = await auroraClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log(`✅ Connected to database (${formatDuration(Date.now() - connectStart)})\n`);

    // =========================================================================
    // STEP 1: Create indexes on raw table for optimal view performance
    // =========================================================================
    console.log('📝 STEP 1: Creating indexes on brand_presence table...');
    const step1Start = Date.now();

    const indexes = [
      { name: 'idx_bp_site_model_date', columns: 'site_id, model, date' },
      { name: 'idx_bp_category', columns: 'category' },
      { name: 'idx_bp_topics', columns: 'topics' },
      { name: 'idx_bp_region', columns: 'region' },
      { name: 'idx_bp_origin', columns: 'origin' },
      { name: 'idx_bp_composite', columns: 'site_id, model, date, category, topics, region, origin' },
    ];

    for (const idx of indexes) {
      await executeWithLogging(
        auroraClient,
        `DROP INDEX IF EXISTS ${idx.name};`,
        `DROP INDEX ${idx.name}`,
      );
      await executeWithLogging(
        auroraClient,
        `CREATE INDEX ${idx.name} ON brand_presence(${idx.columns});`,
        `CREATE INDEX ${idx.name}`,
      );
    }

    // Add index on brand_presence_sources for owned sources lookup (critical for JOIN performance)
    console.log('\n📝 Creating indexes on brand_presence_sources table...');
    await executeWithLogging(
      auroraClient,
      `DROP INDEX IF EXISTS idx_bps_owned_lookup;`,
      'DROP INDEX idx_bps_owned_lookup',
    );
    await executeWithLogging(
      auroraClient,
      `CREATE INDEX idx_bps_owned_lookup ON brand_presence_sources(brand_presence_id) WHERE content_type = 'owned';`,
      'CREATE INDEX idx_bps_owned_lookup (partial index for owned sources)',
    );

    // Add index for all sources lookup (used for joining to count unique sources)
    // Note: We only index brand_presence_id since URLs can be too long for B-tree
    // The COUNT(DISTINCT url) will still work but won't use the URL in the index
    await executeWithLogging(
      auroraClient,
      `DROP INDEX IF EXISTS idx_bps_all_sources_lookup;`,
      'DROP INDEX idx_bps_all_sources_lookup',
    );
    await executeWithLogging(
      auroraClient,
      `CREATE INDEX idx_bps_all_sources_lookup ON brand_presence_sources(brand_presence_id);`,
      'CREATE INDEX idx_bps_all_sources_lookup (for all sources JOIN)',
    );

    stepDurations.step1 = Date.now() - step1Start;
    console.log(`\n✅ STEP 1 completed (${formatDuration(stepDurations.step1)})\n`);

    // =========================================================================
    // STEP 2: Create MATERIALIZED VIEW for topics (daily granularity)
    // =========================================================================
    console.log('📝 STEP 2: Creating brand_presence_topics_by_date materialized view...');
    const step2Start = Date.now();

    await executeWithLogging(
      auroraClient,
      `DROP MATERIALIZED VIEW IF EXISTS brand_presence_topics_by_date CASCADE;`,
      'DROP MATERIALIZED VIEW brand_presence_topics_by_date CASCADE',
    );

    console.log('   ⏳ CREATE MATERIALIZED VIEW brand_presence_topics_by_date (this may take several minutes)...');
    const topicsViewStart = Date.now();
    await auroraClient.query(`
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

        -- Visibility Score: average (NULLs treated as 0)
        ROUND(
          AVG(COALESCE(bp.visibility_score, 0)),
          2
        ) AS avg_visibility_score,

        -- Position: average (excluding non-numeric values)
        ROUND(
          AVG(
            CASE
              WHEN bp.position IS NOT NULL
                AND bp.position != ''
                AND bp.position != 'Not Mentioned'
                AND bp.position ~ '^[0-9]+\\.?[0-9]*$'
              THEN bp.position::NUMERIC
              ELSE NULL
            END
          ),
          2
        ) AS avg_position,

        -- Sentiment counts (used for weighted sentiment calculation)
        COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'positive') AS sentiment_positive,
        COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'neutral') AS sentiment_neutral,
        COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'negative') AS sentiment_negative,

        -- Volume for popularity (application will calculate category)
        ROUND(AVG(bp.volume), 2) AS avg_volume

      FROM brand_presence bp
      LEFT JOIN (
        SELECT DISTINCT brand_presence_id
        FROM brand_presence_sources
        WHERE content_type = 'owned'
      ) owned_sources ON bp.id = owned_sources.brand_presence_id
      GROUP BY bp.site_id, bp.model, bp.date, bp.category, bp.topics, bp.region, bp.origin;
    `);
    console.log(`   ✅ CREATE MATERIALIZED VIEW brand_presence_topics_by_date (${formatDuration(Date.now() - topicsViewStart)})`);

    // Create indexes on materialized view
    console.log('\n📝 Creating indexes on topics materialized view...');

    const topicsIndexes = [
      { name: 'idx_topics_site_model_date', def: 'CREATE INDEX idx_topics_site_model_date ON brand_presence_topics_by_date(site_id, model, date)' },
      { name: 'idx_topics_category', def: 'CREATE INDEX idx_topics_category ON brand_presence_topics_by_date(category)' },
      { name: 'idx_topics_topics', def: 'CREATE INDEX idx_topics_topics ON brand_presence_topics_by_date(topics)' },
      { name: 'idx_topics_region', def: 'CREATE INDEX idx_topics_region ON brand_presence_topics_by_date(region)' },
      { name: 'idx_topics_origin', def: 'CREATE INDEX idx_topics_origin ON brand_presence_topics_by_date(origin)' },
      { name: 'idx_topics_unique', def: 'CREATE UNIQUE INDEX idx_topics_unique ON brand_presence_topics_by_date(site_id, model, date, category, topics, region, origin)' },
    ];

    for (const idx of topicsIndexes) {
      await executeWithLogging(auroraClient, `DROP INDEX IF EXISTS ${idx.name};`, `DROP INDEX ${idx.name}`);
      await executeWithLogging(auroraClient, idx.def, `CREATE INDEX ${idx.name}`);
    }

    stepDurations.step2 = Date.now() - step2Start;
    console.log(`\n✅ STEP 2 completed (${formatDuration(stepDurations.step2)})\n`);

    // =========================================================================
    // STEP 3: Create MATERIALIZED VIEW for prompts (daily granularity)
    // =========================================================================
    console.log('📝 STEP 3: Creating brand_presence_prompts_by_date materialized view...');
    const step3Start = Date.now();


    // Drop the materialized view (handles both materialized and regular views via CASCADE)
    await executeWithLogging(
      auroraClient,
      `DROP MATERIALIZED VIEW IF EXISTS brand_presence_prompts_by_date CASCADE;`,
      'DROP MATERIALIZED VIEW brand_presence_prompts_by_date CASCADE',
    );

    console.log('   ⏳ CREATE MATERIALIZED VIEW brand_presence_prompts_by_date (this may take several minutes)...');
    const promptsViewStart = Date.now();
    await auroraClient.query(`
      CREATE MATERIALIZED VIEW brand_presence_prompts_by_date AS
      SELECT
        bp.site_id,
        bp.model,
        bp.date,
        bp.category,
        bp.topics,
        bp.prompt,
        bp.region,
        bp.origin,

        -- Execution count for this prompt
        COUNT(*) AS executions_count,

        -- Mentions
        COUNT(*) FILTER (WHERE bp.mentions = TRUE) AS mentions_count,

        -- Citations: count of executions with at least one owned source
        COUNT(DISTINCT CASE WHEN owned_sources.brand_presence_id IS NOT NULL THEN bp.id END) AS citations_count,

        -- Visibility Score (NULLs treated as 0)
        ROUND(
          AVG(COALESCE(bp.visibility_score, 0)),
          2
        ) AS avg_visibility_score,

        -- Position
        ROUND(
          AVG(
            CASE
              WHEN bp.position IS NOT NULL
                AND bp.position != ''
                AND bp.position != 'Not Mentioned'
                AND bp.position ~ '^[0-9]+\\.?[0-9]*$'
              THEN bp.position::NUMERIC
              ELSE NULL
            END
          ),
          2
        ) AS avg_position,

        -- Average sentiment score (used for sentiment classification)
        ROUND(
          AVG(
            CASE
              WHEN LOWER(bp.sentiment) = 'positive' THEN 1.0
              WHEN LOWER(bp.sentiment) = 'neutral' THEN 0.0
              WHEN LOWER(bp.sentiment) = 'negative' THEN -1.0
              ELSE NULL
            END
          ),
          2
        ) AS avg_sentiment_score,

        -- Latest answer (for detail view)
        (ARRAY_AGG(bp.answer ORDER BY bp.date DESC))[1] AS latest_answer

      FROM brand_presence bp
      LEFT JOIN (
        SELECT DISTINCT brand_presence_id
        FROM brand_presence_sources
        WHERE content_type = 'owned'
      ) owned_sources ON bp.id = owned_sources.brand_presence_id
      GROUP BY bp.site_id, bp.model, bp.date, bp.category, bp.topics, bp.prompt, bp.region, bp.origin;
    `);
    console.log(`   ✅ CREATE MATERIALIZED VIEW brand_presence_prompts_by_date (${formatDuration(Date.now() - promptsViewStart)})`);

    // Create indexes on prompts materialized view
    console.log('\n📝 Creating indexes on prompts materialized view...');

    const promptsIndexes = [
      { name: 'idx_prompts_site_model_date', def: 'CREATE INDEX idx_prompts_site_model_date ON brand_presence_prompts_by_date(site_id, model, date)' },
      { name: 'idx_prompts_topics', def: 'CREATE INDEX idx_prompts_topics ON brand_presence_prompts_by_date(topics)' },
      { name: 'idx_prompts_category', def: 'CREATE INDEX idx_prompts_category ON brand_presence_prompts_by_date(category)' },
      { name: 'idx_prompts_region', def: 'CREATE INDEX idx_prompts_region ON brand_presence_prompts_by_date(region)' },
      { name: 'idx_prompts_origin', def: 'CREATE INDEX idx_prompts_origin ON brand_presence_prompts_by_date(origin)' },
      { name: 'idx_prompts_composite', def: 'CREATE INDEX idx_prompts_composite ON brand_presence_prompts_by_date(site_id, model, date, topics)' },
      { name: 'idx_prompts_unique', def: 'CREATE UNIQUE INDEX idx_prompts_unique ON brand_presence_prompts_by_date(site_id, model, date, category, topics, prompt, region, origin)' },
    ];

    for (const idx of promptsIndexes) {
      await executeWithLogging(auroraClient, `DROP INDEX IF EXISTS ${idx.name};`, `DROP INDEX ${idx.name}`);
      await executeWithLogging(auroraClient, idx.def, `CREATE INDEX ${idx.name}`);
    }

    stepDurations.step3 = Date.now() - step3Start;
    console.log(`\n✅ STEP 3 completed (${formatDuration(stepDurations.step3)})\n`);

    // =========================================================================
    // STEP 4: Create refresh functions
    // =========================================================================
    console.log('📝 STEP 4: Creating refresh functions...');
    const step4Start = Date.now();

    await executeWithLogging(
      auroraClient,
      `CREATE OR REPLACE FUNCTION refresh_brand_presence_views()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY brand_presence_topics_by_date;
        REFRESH MATERIALIZED VIEW CONCURRENTLY brand_presence_prompts_by_date;
      END;
      $$ LANGUAGE plpgsql;`,
      'CREATE FUNCTION refresh_brand_presence_views()',
    );

    await executeWithLogging(
      auroraClient,
      `CREATE OR REPLACE FUNCTION refresh_brand_presence_topics()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY brand_presence_topics_by_date;
      END;
      $$ LANGUAGE plpgsql;`,
      'CREATE FUNCTION refresh_brand_presence_topics()',
    );

    await executeWithLogging(
      auroraClient,
      `CREATE OR REPLACE FUNCTION refresh_brand_presence_prompts()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY brand_presence_prompts_by_date;
      END;
      $$ LANGUAGE plpgsql;`,
      'CREATE FUNCTION refresh_brand_presence_prompts()',
    );

    stepDurations.step4 = Date.now() - step4Start;
    console.log(`\n✅ STEP 4 completed (${formatDuration(stepDurations.step4)})\n`);

    // =========================================================================
    // STEP 5: Verification
    // =========================================================================
    console.log('📝 STEP 5: Verifying views...');
    const step5Start = Date.now();

    console.log('   ⏳ Counting rows in brand_presence_topics_by_date...');
    const topicsCountStart = Date.now();
    const topicsCount = await auroraClient.query(`
      SELECT COUNT(*) as count FROM brand_presence_topics_by_date;
    `);
    console.log(`   ✅ brand_presence_topics_by_date: ${topicsCount[0].count} rows (${formatDuration(Date.now() - topicsCountStart)})`);

    console.log('   ⏳ Counting rows in brand_presence_prompts_by_date...');
    const promptsCountStart = Date.now();
    const promptsCount = await auroraClient.query(`
      SELECT COUNT(*) as count FROM brand_presence_prompts_by_date;
    `);
    console.log(`   ✅ brand_presence_prompts_by_date: ${promptsCount[0].count} rows (${formatDuration(Date.now() - promptsCountStart)})`);

    // Sample query demonstration
    if (parseInt(topicsCount[0].count, 10) > 0) {
      console.log('\n📋 Sample topic aggregation query:');
      const sampleStart = Date.now();
      const sampleTopics = await auroraClient.query(`
        SELECT
          topics,
          SUM(executions_count) AS executions,
          SUM(mentions_count) AS mentions,
          SUM(citations_count) AS citations,
          ROUND(AVG(avg_visibility_score), 2) AS visibility,
          AVG(avg_volume) AS volume
        FROM brand_presence_topics_by_date
        GROUP BY topics
        ORDER BY mentions DESC
        LIMIT 3;
      `);
      console.log(`   (query took ${formatDuration(Date.now() - sampleStart)})\n`);

      sampleTopics.forEach((row) => {
        console.log(`   "${row.topics}"`);
        console.log(`     Executions: ${row.executions}, Mentions: ${row.mentions}, Citations: ${row.citations}`);
        console.log(`     Visibility: ${row.visibility}%, Volume: ${row.volume}\n`);
      });
    }

    stepDurations.step5 = Date.now() - step5Start;
    console.log(`✅ STEP 5 completed (${formatDuration(stepDurations.step5)})\n`);

    // =========================================================================
    // Summary
    // =========================================================================
    const totalDuration = Date.now() - scriptStartTime;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ Brand Presence Views Created Successfully!');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('⏱️  Duration Summary:\n');
    console.log(`   STEP 1 (Indexes on base tables):      ${formatDuration(stepDurations.step1)}`);
    console.log(`   STEP 2 (Topics materialized view):    ${formatDuration(stepDurations.step2)}`);
    console.log(`   STEP 3 (Prompts materialized view):   ${formatDuration(stepDurations.step3)}`);
    console.log(`   STEP 4 (Refresh functions):           ${formatDuration(stepDurations.step4)}`);
    console.log(`   STEP 5 (Verification):                ${formatDuration(stepDurations.step5)}`);
    console.log(`   ─────────────────────────────────────────────────`);
    console.log(`   TOTAL:                                ${formatDuration(totalDuration)}\n`);

    console.log('📝 Views created:\n');
    console.log('   1. brand_presence_topics_by_date (MATERIALIZED)');
    console.log('      GROUP BY: site_id, model, date, category, topics, region, origin');
    console.log('      Use for: Topic list with all filters\n');

    console.log('   2. brand_presence_prompts_by_date (MATERIALIZED)');
    console.log('      GROUP BY: site_id, model, date, category, topics, prompt, region, origin');
    console.log('      Use for: Expanded prompts, prompt counts\n');

    console.log('📝 Refresh functions:\n');
    console.log('   - refresh_brand_presence_views()   -- Refreshes both views');
    console.log('   - refresh_brand_presence_topics()  -- Refreshes topics only');
    console.log('   - refresh_brand_presence_prompts() -- Refreshes prompts only\n');

    console.log('📝 Example queries:\n');

    console.log('-- Get topics for Data Insights Table:');
    console.log(`SELECT
  topics,
  SUM(executions_count) AS executions,
  SUM(mentions_count) AS mentions,
  SUM(citations_count) AS citations,
  ROUND(AVG(avg_visibility_score), 2) AS visibility,
  SUM(sentiment_positive) AS positive,
  SUM(sentiment_neutral) AS neutral,
  SUM(sentiment_negative) AS negative,
  ROUND(AVG(avg_position), 2) AS position,
  SUM(total_sources_count) AS sources,
  AVG(avg_volume) AS volume
FROM brand_presence_topics_by_date
WHERE site_id = 'your-site-id'
  AND model = 'chatgpt'
  AND date BETWEEN '2025-01-01' AND '2025-01-31'
  AND ($category IS NULL OR category = $category)
  AND ($region IS NULL OR region = $region)
  AND ($origin IS NULL OR origin = $origin)
GROUP BY topics
ORDER BY mentions DESC;
`);

    console.log('\n-- Get prompt count for a topic:');
    console.log(`SELECT COUNT(DISTINCT prompt || '|' || region) AS prompts_count
FROM brand_presence_prompts_by_date
WHERE site_id = 'your-site-id'
  AND topics = 'Your Topic'
  AND date BETWEEN '2025-01-01' AND '2025-01-31'
  AND (filters...);
`);

    console.log('\n-- Get prompts when expanding a topic:');
    console.log(`SELECT
  prompt,
  region,
  origin,
  SUM(executions_count) AS executions,
  SUM(mentions_count) AS mentions,
  SUM(citations_count) AS citations,
  ROUND(AVG(avg_visibility_score), 2) AS visibility,
  dominant_sentiment,
  ROUND(AVG(avg_position), 2) AS position,
  SUM(total_sources_count) AS sources
FROM brand_presence_prompts_by_date
WHERE site_id = 'your-site-id'
  AND topics = 'Your Topic'
  AND date BETWEEN '2025-01-01' AND '2025-01-31'
  AND (filters...)
GROUP BY prompt, region, origin, dominant_sentiment
ORDER BY mentions DESC;
`);

    console.log('\n-- Refresh after daily import:');
    console.log('SELECT refresh_brand_presence_views();\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

createBrandPresenceViews();
