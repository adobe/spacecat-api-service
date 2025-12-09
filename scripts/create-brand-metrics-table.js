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
 * Creates the brand_metrics_weekly table.
 *
 * This table stores pre-aggregated weekly metrics from brand_presence
 * to speed up dashboard queries (especially competitor comparison).
 *
 * Granularity: One row per site, week, model, category, region, topics
 */
async function createMetricsTable() {
  console.log('🚀 Creating brand_metrics_weekly table...\n');

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

    // Drop existing table
    console.log('📝 Dropping existing table if exists...');
    await auroraClient.query('DROP TABLE IF EXISTS brand_metrics_weekly CASCADE;');
    console.log('✅ Dropped (if existed)\n');

    // Create table
    console.log('📝 Creating brand_metrics_weekly table...');
    await auroraClient.query(`
      CREATE TABLE brand_metrics_weekly (
        id SERIAL PRIMARY KEY,

        -- Dimensions
        site_id UUID NOT NULL,
        week VARCHAR(10) NOT NULL, -- Format: YYYY-WNN
        model VARCHAR(100),
        category VARCHAR(255),
        region VARCHAR(100),
        topics TEXT, -- Kept as text to support ILIKE filtering
        competitors TEXT, -- Pre-aggregated competitor list

        -- Metrics
        mentions_count INTEGER DEFAULT 0,
        citations_count INTEGER DEFAULT 0,
        prompt_count INTEGER DEFAULT 0,

        -- Metadata
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table created\n');

    // Create indexes
    console.log('📝 Creating indexes...');

    await auroraClient.query(`
      CREATE INDEX idx_bmw_site_week ON brand_metrics_weekly(site_id, week);
    `);
    console.log('   ✅ idx_bmw_site_week');

    await auroraClient.query(`
      CREATE INDEX idx_bmw_composite ON brand_metrics_weekly(site_id, week, model, category, region);
    `);
    console.log('   ✅ idx_bmw_composite');

    // Verify
    console.log('🔍 Verifying table structure...');
    const columns = await auroraClient.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'brand_metrics_weekly'
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 Table columns:');
    columns.forEach((col) => {
      console.log(`   ${col.column_name}: ${col.data_type}`);
    });

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ brand_metrics_weekly Table Created Successfully!');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

createMetricsTable();

