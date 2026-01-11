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
 * Refreshes the brand_metrics_weekly table from brand_presence and brand_presence_sources.
 */
async function refreshMetrics() {
  const args = process.argv.slice(2);
  const siteUrlArg = args.find((arg) => arg.startsWith('--site-url='));

  if (!siteUrlArg) {
    console.error('❌ Error: --site-url parameter is required');
    process.exit(1);
  }

  const siteBaseUrl = siteUrlArg.split('=')[1];
  console.log('🚀 Refreshing brand_metrics_weekly table...');
  console.log(`   Site URL: ${siteBaseUrl}\n`);

  const auroraClient = new AuroraClient({
    host: 'localhost',
    port: 5432,
    database: 'spacecatdb',
    user: 'spacecatuser',
    password: 'spacecatpassword',
    ssl: false,
  });

  try {
    const connected = await auroraClient.testConnection();
    if (!connected) throw new Error('Failed to connect to database');
    console.log('✅ Connected to database\n');

    console.log('📝 Truncating brand_metrics_weekly table...');
    await auroraClient.query('TRUNCATE TABLE brand_metrics_weekly');
    console.log('✅ Truncated\n');

    console.log('📝 Aggregating data and populating table...');
    
    // This query aggregates brand_presence data into weekly metrics
    // It joins with brand_presence_sources to count citations
    const populateQuery = `
      INSERT INTO brand_metrics_weekly 
      (site_id, week, model, category, region, topics, competitors, mentions_count, citations_count, prompt_count)
      SELECT 
        bp.site_id,
        TO_CHAR(bp.execution_date, 'IYYY-"W"IW') as week,
        bp.model,
        bp.category,
        bp.region,
        bp.topics,
        
        -- Aggregated competitors for this group
        STRING_AGG(DISTINCT bp.business_competitors, ';') as competitors,
        
        -- Count mentions (unique prompts within week)
        COUNT(DISTINCT CASE WHEN bp.mentions = true THEN bp.prompt END) as mentions_count,
        
        -- Count citations (unique prompts within week with citations)
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM brand_presence_sources bps 
          WHERE bps.brand_presence_id = bp.id AND bps.is_owned = true
        ) THEN bp.prompt END) as citations_count,
        
        -- Total prompts count (unique within week)
        COUNT(DISTINCT bp.prompt) as prompt_count
        
      FROM brand_presence bp
      GROUP BY 1, 2, 3, 4, 5, 6
    `;

    const start = Date.now();
    await auroraClient.query(populateQuery);
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    console.log(`✅ Data populated in ${duration}s\n`);

    // Verification
    const count = await auroraClient.query('SELECT COUNT(*) as c FROM brand_metrics_weekly');
    console.log(`📊 Total records created: ${count[0].c}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

refreshMetrics();

