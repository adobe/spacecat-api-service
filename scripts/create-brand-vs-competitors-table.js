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
 * Create the brand_vs_competitors table with proper schema
 */
async function createBrandVsCompetitorsTable() {
  console.log('🚀 Creating brand_vs_competitors table...\n');

  const auroraClient = new AuroraClient({
    host: 'localhost',
    port: 5432,
    database: 'spacecatdb',
    user: 'spacecatuser',
    password: 'spacecatpassword',
    ssl: false,
  });

  try {
    // Test connection
    console.log('🔌 Testing database connection...');
    const connected = await auroraClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('✅ Connected to database\n');

    // Drop table if exists (for clean slate)
    console.log('🗑️  Dropping existing table if exists...');
    await auroraClient.query('DROP TABLE IF EXISTS brand_vs_competitors CASCADE');
    console.log('✅ Table dropped (if existed)\n');

    // Create table with schema based on inspection
    console.log('📋 Creating brand_vs_competitors table...');
    const createTableSQL = `
      CREATE TABLE brand_vs_competitors (
        -- Auto-increment primary key
        id SERIAL PRIMARY KEY,

        -- Keys for identification
        site_id UUID NOT NULL,
        date DATE NOT NULL,
        model VARCHAR(100) NOT NULL,  -- ai-mode, chatgpt, copilot, gemini, etc.

        -- Data columns from "brand_vs_competitors" sheet
        category VARCHAR(255),
        competitor VARCHAR(255),
        mentions INTEGER,
        citations INTEGER,
        sources TEXT,
        region VARCHAR(10),

        -- Metadata
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    await auroraClient.query(createTableSQL);
    console.log('✅ Table created successfully\n');

    // Create indexes for performance
    console.log('📊 Creating indexes...');

    await auroraClient.query(`
      CREATE INDEX idx_brand_vs_competitors_site_id ON brand_vs_competitors(site_id);
    `);
    console.log('  ✅ Created index on site_id');

    await auroraClient.query(`
      CREATE INDEX idx_brand_vs_competitors_date ON brand_vs_competitors(date);
    `);
    console.log('  ✅ Created index on date');

    await auroraClient.query(`
      CREATE INDEX idx_brand_vs_competitors_category ON brand_vs_competitors(category);
    `);
    console.log('  ✅ Created index on category');

    await auroraClient.query(`
      CREATE INDEX idx_brand_vs_competitors_competitor ON brand_vs_competitors(competitor);
    `);
    console.log('  ✅ Created index on competitor');

    await auroraClient.query(`
      CREATE INDEX idx_brand_vs_competitors_region ON brand_vs_competitors(region);
    `);
    console.log('  ✅ Created index on region');

    await auroraClient.query(`
      CREATE INDEX idx_brand_vs_competitors_model ON brand_vs_competitors(model);
    `);
    console.log('  ✅ Created index on model');

    console.log('\n✅ All indexes created successfully\n');

    // Verify table creation
    console.log('🔍 Verifying table structure...');
    const tableInfo = await auroraClient.query(`
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'brand_vs_competitors'
      ORDER BY ordinal_position;
    `);

    console.log(`\n📋 Table "brand_vs_competitors" has ${tableInfo.length} columns:\n`);
    tableInfo.forEach((col) => {
      const nullable = col.is_nullable === 'YES' ? '(nullable)' : '(required)';
      const defaultVal = col.column_default ? ` [default: ${col.column_default}]` : '';
      console.log(`  - ${col.column_name}: ${col.data_type} ${nullable}${defaultVal}`);
    });

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('✅ Brand vs Competitors Table Creation Complete!');
    console.log('═══════════════════════════════════════════════════════\n');
  } catch (error) {
    console.error('❌ Error creating table:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

// Run the script
createBrandVsCompetitorsTable();
