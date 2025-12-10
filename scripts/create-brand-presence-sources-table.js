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
 * Creates the brand_presence_sources table.
 *
 * This table stores parsed sources from the brand_presence.sources field
 * with pre-calculated content_type classification:
 * - owned: URL matches site's base URL
 * - competitor: URL matches a known competitor
 * - social: URL is from social media platforms
 * - earned: Everything else (third-party)
 *
 * Relationship: brand_presence (1) -> (n) brand_presence_sources
 */
async function createSourcesTable() {
  console.log('🚀 Creating brand_presence_sources table...\n');

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
    await auroraClient.query('DROP TABLE IF EXISTS brand_presence_sources CASCADE;');
    console.log('✅ Dropped (if existed)\n');

    // Create table
    console.log('📝 Creating brand_presence_sources table...');
    await auroraClient.query(`
      CREATE TABLE brand_presence_sources (
        id SERIAL PRIMARY KEY,

        -- Foreign key to brand_presence
        brand_presence_id INTEGER NOT NULL REFERENCES brand_presence(id) ON DELETE CASCADE,

        -- Denormalized for easier querying (avoids joins)
        site_id UUID NOT NULL,
        date DATE NOT NULL,
        model VARCHAR(100) NOT NULL,

        -- Source URL data
        url TEXT NOT NULL,
        hostname VARCHAR(255),

        -- Classification (pre-calculated)
        content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('owned', 'competitor', 'social', 'earned')),
        is_owned BOOLEAN GENERATED ALWAYS AS (content_type = 'owned') STORED,

        -- Metadata
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table created\n');

    // Create indexes
    console.log('📝 Creating indexes...');

    await auroraClient.query(`
      CREATE INDEX idx_bps_brand_presence_id ON brand_presence_sources(brand_presence_id);
    `);
    console.log('   ✅ idx_bps_brand_presence_id');

    await auroraClient.query(`
      CREATE INDEX idx_bps_site_date ON brand_presence_sources(site_id, date);
    `);
    console.log('   ✅ idx_bps_site_date');

    await auroraClient.query(`
      CREATE INDEX idx_bps_content_type ON brand_presence_sources(content_type);
    `);
    console.log('   ✅ idx_bps_content_type');

    await auroraClient.query(`
      CREATE INDEX idx_bps_is_owned ON brand_presence_sources(is_owned) WHERE is_owned = true;
    `);
    console.log('   ✅ idx_bps_is_owned');

    await auroraClient.query(`
      CREATE INDEX idx_bps_hostname ON brand_presence_sources(hostname);
    `);
    console.log('   ✅ idx_bps_hostname');

    // Composite index for common queries
    await auroraClient.query(`
      CREATE INDEX idx_bps_composite ON brand_presence_sources(site_id, model, date, content_type);
    `);
    console.log('   ✅ idx_bps_composite\n');

    // Verify
    console.log('🔍 Verifying table structure...');
    const columns = await auroraClient.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'brand_presence_sources'
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 Table columns:');
    columns.forEach((col) => {
      console.log(`   ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? '(required)' : ''}`);
    });

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ brand_presence_sources Table Created Successfully!');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('📝 Next steps:');
    console.log('   1. Run: node scripts/refresh-brand-presence-sources.js --site-url=https://your-site.com');
    console.log('   2. This will parse sources and populate the table\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

createSourcesTable();

