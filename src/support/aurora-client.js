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

import pg from 'pg';

const { Pool } = pg;

/**
 * PostgreSQL/Aurora client wrapper for SpaceCat
 * Supports both local PostgreSQL and AWS Aurora PostgreSQL
 */
export class AuroraClient {
  constructor(config) {
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'spacecatdb',
      user: config.user || 'spacecatuser',
      password: config.password || 'spacecatpassword',
      max: config.max || 20, // Maximum number of connections in pool
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
      // For Aurora, enable SSL
      ssl: config.ssl !== undefined ? config.ssl : (config.host !== 'localhost'),
    };

    this.pool = new Pool(this.config);

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  /**
         * Create AuroraClient from Lambda context
         * @param {Object} context - Lambda context with env variables
         * @returns {AuroraClient}
         */
  static fromContext(context) {
    const { env } = context;

    // Determine SSL setting: use POSTGRES_SSL for local, AURORA_SSL for Aurora
    let sslSetting;
    if (env.POSTGRES_HOST && !env.AURORA_HOST) {
      // Using local PostgreSQL
      sslSetting = env.POSTGRES_SSL === 'true';
    } else {
      // Using Aurora
      sslSetting = env.AURORA_SSL !== 'false';
    }

    return new AuroraClient({
      host: env.AURORA_HOST || env.POSTGRES_HOST,
      port: env.AURORA_PORT || env.POSTGRES_PORT,
      database: env.AURORA_DATABASE || env.POSTGRES_DATABASE,
      user: env.AURORA_USER || env.POSTGRES_USER,
      password: env.AURORA_PASSWORD || env.POSTGRES_PASSWORD,
      max: parseInt(env.AURORA_MAX_CONNECTIONS || '20', 10),
      ssl: sslSetting,
    });
  }

  /**
         * Execute a query with automatic connection management
         * @param {string} sql - SQL query string
         * @param {Array} params - Query parameters
         * @returns {Promise<Array>} Query results
         */
  async query(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const start = Date.now();
      const result = await client.query(sql, params);
      const duration = Date.now() - start;

      // Log slow queries (>1000ms)
      if (duration > 1000) {
        console.warn(`Slow query detected (${duration}ms):`, sql.substring(0, 100));
      }

      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
         * Execute a query and return a single row
         * @param {string} sql - SQL query string
         * @param {Array} params - Query parameters
         * @returns {Promise<Object|null>} Single row or null
         */
  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
         * Execute a query within a transaction
         * @param {Function} callback - Async function that receives a client
         * @returns {Promise<any>} Result from callback
         */
  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
         * Execute multiple queries in a batch
         * @param {Array<{sql: string, params: Array}>} queries - Array of query objects
         * @returns {Promise<Array>} Array of results
         */
  async batch(queries) {
    return this.transaction(async (client) => {
      const results = [];
      for (const { sql, params = [] } of queries) {
        // eslint-disable-next-line no-await-in-loop
        const result = await client.query(sql, params);
        results.push(result.rows);
      }
      return results;
    });
  }

  /**
         * Test database connection
         * @returns {Promise<boolean>} True if connected
         */
  async testConnection() {
    try {
      const result = await this.query('SELECT 1 as connected, version() as version');
      return result.length > 0;
    } catch (error) {
      console.error('Database connection test failed:', error);
      return false;
    }
  }

  /**
         * Get connection pool statistics
         * @returns {Object} Pool stats
         */
  getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
         * Close all connections in the pool
         * @returns {Promise<void>}
         */
  async close() {
    await this.pool.end();
  }
}

/**
 * Wrapper function for Lambda to add Aurora client to context
 * @param {Function} fn - Handler function
 * @returns {Function} Wrapped handler
 */
export function auroraClientWrapper(fn) {
  return async (request, context) => {
    // Only initialize if Aurora is configured
    if (context.env.AURORA_HOST || context.env.POSTGRES_HOST) {
      const auroraClient = AuroraClient.fromContext(context);

      // Add to context
      // eslint-disable-next-line no-param-reassign
      context.aurora = auroraClient;

      try {
        return await fn(request, context);
      } finally {
        // Clean up connections after Lambda execution
        await auroraClient.close();
      }
    }

    return fn(request, context);
  };
}

export default AuroraClient;
