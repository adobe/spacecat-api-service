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
 * Creates the Data Insights views for Brand Presence.
 *
 * Architecture:
 * 1. brand_presence_topics_by_date (Materialized View)
 *    - Grouped by: site_id, model, date, category, topics, region, origin
 *    - Pre-calculated metrics for fast topic-level queries
 *    - Refresh daily after data import
 *
 * 2. brand_presence_prompts_by_date (Regular View)
 *    - Grouped by: site_id, model, date, category, topics, prompt, region, origin
 *    - Calculated on-demand when user expands a topic
 *
 * Query Flow:
 * - Topic list: Query topics view with filters, GROUP BY topics
 * - Prompt count: Query prompts view with filters, COUNT DISTINCT
 * - Expand topic: Query prompts view filtered to one topic
 */
async function createBrandPresenceViews() {
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
    const connected = await auroraClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('✅ Connected to database\n');

    // =========================================================================
    // STEP 1: Create indexes on raw table for optimal view performance
    // =========================================================================
    console.log('📝 Creating indexes on brand_presence table...');

    const indexes = [
      { name: 'idx_bp_site_model_date', columns: 'site_id, model, date' },
      { name: 'idx_bp_category', columns: 'category' },
      { name: 'idx_bp_topics', columns: 'topics' },
      { name: 'idx_bp_region', columns: 'region' },
      { name: 'idx_bp_origin', columns: 'origin' },
      { name: 'idx_bp_composite', columns: 'site_id, model, date, category, topics, region, origin' },
    ];

    for (const idx of indexes) {
      await auroraClient.query(`DROP INDEX IF EXISTS ${idx.name};`);
      await auroraClient.query(`CREATE INDEX ${idx.name} ON brand_presence(${idx.columns});`);
      console.log(`   ✅ ${idx.name}`);
    }
    console.log('');

    // =========================================================================
    // STEP 2: Create MATERIALIZED VIEW for topics (daily granularity)
    // =========================================================================
    console.log('📝 Creating brand_presence_topics_by_date materialized view...');

    await auroraClient.query(`DROP MATERIALIZED VIEW IF EXISTS brand_presence_topics_by_date CASCADE;`);

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

        -- Unique prompts in this grouping (for reference)
        COUNT(DISTINCT bp.prompt) AS unique_prompts_in_group,

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

        -- Sentiment counts
        COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'positive') AS sentiment_positive,
        COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'neutral') AS sentiment_neutral,
        COUNT(*) FILTER (WHERE LOWER(bp.sentiment) = 'negative') AS sentiment_negative,
        COUNT(*) FILTER (WHERE bp.sentiment IS NOT NULL AND bp.sentiment != '') AS sentiment_total,

        -- Average sentiment score (-1 to 1)
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

        -- Sources count (total across all executions)
        SUM(
          CASE
            WHEN bp.sources IS NULL OR bp.sources = '' THEN 0
            ELSE array_length(string_to_array(bp.sources, ';'), 1)
          END
        ) AS total_sources_count,

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
    console.log('✅ brand_presence_topics_by_date created\n');

    // Create indexes on materialized view
    console.log('📝 Creating indexes on topics materialized view...');

    const topicsIndexes = [
      { name: 'idx_topics_site_model_date', def: 'CREATE INDEX idx_topics_site_model_date ON brand_presence_topics_by_date(site_id, model, date)' },
      { name: 'idx_topics_category', def: 'CREATE INDEX idx_topics_category ON brand_presence_topics_by_date(category)' },
      { name: 'idx_topics_topics', def: 'CREATE INDEX idx_topics_topics ON brand_presence_topics_by_date(topics)' },
      { name: 'idx_topics_region', def: 'CREATE INDEX idx_topics_region ON brand_presence_topics_by_date(region)' },
      { name: 'idx_topics_origin', def: 'CREATE INDEX idx_topics_origin ON brand_presence_topics_by_date(origin)' },
      { name: 'idx_topics_unique', def: 'CREATE UNIQUE INDEX idx_topics_unique ON brand_presence_topics_by_date(site_id, model, date, category, topics, region, origin)' },
    ];

    for (const idx of topicsIndexes) {
      await auroraClient.query(`DROP INDEX IF EXISTS ${idx.name};`);
      await auroraClient.query(idx.def);
      console.log(`   ✅ ${idx.name}`);
    }
    console.log('');

    // =========================================================================
    // STEP 3: Create REGULAR VIEW for prompts (daily granularity)
    // =========================================================================
    console.log('📝 Creating brand_presence_prompts_by_date regular view...');

    await auroraClient.query(`DROP VIEW IF EXISTS brand_presence_prompts_by_date CASCADE;`);

    await auroraClient.query(`
      CREATE VIEW brand_presence_prompts_by_date AS
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

        -- Dominant sentiment (mode)
        MODE() WITHIN GROUP (ORDER BY bp.sentiment) AS dominant_sentiment,

        -- Average sentiment score
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

        -- Sources count
        SUM(
          CASE
            WHEN bp.sources IS NULL OR bp.sources = '' THEN 0
            ELSE array_length(string_to_array(bp.sources, ';'), 1)
          END
        ) AS total_sources_count,

        -- Latest answer (for detail view)
        (ARRAY_AGG(bp.answer ORDER BY bp.date DESC))[1] AS latest_answer,

        -- Latest sources (for detail view)
        (ARRAY_AGG(bp.sources ORDER BY bp.date DESC))[1] AS latest_sources

      FROM brand_presence bp
      LEFT JOIN (
        SELECT DISTINCT brand_presence_id
        FROM brand_presence_sources
        WHERE content_type = 'owned'
      ) owned_sources ON bp.id = owned_sources.brand_presence_id
      GROUP BY bp.site_id, bp.model, bp.date, bp.category, bp.topics, bp.prompt, bp.region, bp.origin;
    `);
    console.log('✅ brand_presence_prompts_by_date created\n');

    // =========================================================================
    // STEP 4: Create refresh function
    // =========================================================================
    console.log('📝 Creating refresh function...');

    await auroraClient.query(`
      CREATE OR REPLACE FUNCTION refresh_brand_presence_views()
      RETURNS void AS $$
      BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY brand_presence_topics_by_date;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('✅ refresh_brand_presence_views() function created\n');

    // =========================================================================
    // STEP 5: Verification
    // =========================================================================
    console.log('🔍 Verifying views...\n');

    const topicsCount = await auroraClient.query(`
      SELECT COUNT(*) as count FROM brand_presence_topics_by_date;
    `);
    console.log(`   brand_presence_topics_by_date: ${topicsCount[0].count} rows`);

    const promptsCount = await auroraClient.query(`
      SELECT COUNT(*) as count FROM brand_presence_prompts_by_date;
    `);
    console.log(`   brand_presence_prompts_by_date: ${promptsCount[0].count} rows\n`);

    // Sample query demonstration
    if (parseInt(topicsCount[0].count, 10) > 0) {
      console.log('📋 Sample topic aggregation query:\n');

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

      sampleTopics.forEach((row) => {
        console.log(`   "${row.topics}"`);
        console.log(`     Executions: ${row.executions}, Mentions: ${row.mentions}, Citations: ${row.citations}`);
        console.log(`     Visibility: ${row.visibility}%, Volume: ${row.volume}\n`);
      });
    }

    // =========================================================================
    // Summary
    // =========================================================================
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ Brand Presence Views Created Successfully!');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('📝 Views created:\n');
    console.log('   1. brand_presence_topics_by_date (MATERIALIZED)');
    console.log('      GROUP BY: site_id, model, date, category, topics, region, origin');
    console.log('      Use for: Topic list with all filters\n');

    console.log('   2. brand_presence_prompts_by_date (REGULAR VIEW)');
    console.log('      GROUP BY: site_id, model, date, category, topics, prompt, region, origin');
    console.log('      Use for: Expanded prompts, prompt counts\n');

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
