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

import { createClient } from 'redis';

// Cache TTL in seconds (2 hours by default)
const CACHE_TTL_SECONDS = 2 * 60 * 60;

/**
 * LLMO Cache Helper using AWS ElastiCache Valkey (Redis-compatible)
 */
class ValkeyCache {
  constructor(env, log) {
    this.log = log;
    this.env = env;
    this.client = null;
    this.isConnected = false;
  }

  /**
   * Initialize and connect to Valkey (lazy connection)
   */
  async connect() {
    if (this.isConnected && this.client) {
      return;
    }

    try {
      // Use environment variable or default host (without protocol prefix)
      const host = this.env.VALKEY_HOST || 'elmodata-u65bcl.serverless.use1.cache.amazonaws.com';
      const port = this.env.VALKEY_PORT || 6379;

      this.log.info(`Attempting to connect to ElastiCache Valkey at ${host}:${port} with TLS`);

      this.client = createClient({
        socket: {
          host,
          port: parseInt(port, 10),
          connectTimeout: 10000, // 10 seconds timeout
          tls: true, // Enable TLS for ElastiCache connections
          rejectUnauthorized: false, // AWS certificates are self-signed
          reconnectStrategy: (retries) => {
            if (retries > 3) {
              this.log.error('Max Valkey reconnection attempts reached');
              return false; // Stop reconnecting
            }
            return Math.min(retries * 100, 3000);
          },
        },
      });

      this.client.on('error', (err) => {
        this.log.error(`Valkey client error: ${err.message}`);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        this.log.info('Valkey client connected');
        this.isConnected = true;
      });

      this.client.on('disconnect', () => {
        this.log.warn('Valkey client disconnected');
        this.isConnected = false;
      });

      await this.client.connect();
      this.isConnected = true;
      this.log.info('Successfully connected to ElastiCache Valkey');
    } catch (error) {
      this.log.error(`Failed to connect to Valkey: ${error.message}`);
      this.isConnected = false;
      this.client = null;
    }
  }

  /**
   * Generate cache key for a file path
   */
  static getCacheKey(filePath) {
    return `llmo:file:${filePath}`;
  }

  /**
   * Get cached data for a file
   * @param {string} filePath - The file path to use as cache key
   * @returns {Promise<object|null>} - The cached data or null if not found
   */
  async get(filePath) {
    // Lazy connect on first use
    await this.connect();
    if (!this.isConnected || !this.client) {
      this.log.warn('Valkey not connected, skipping cache get');
      return null;
    }

    try {
      const cacheKey = ValkeyCache.getCacheKey(filePath);
      this.log.info(`Checking Valkey cache for key: ${cacheKey}`);

      const cachedData = await this.client.get(cacheKey);

      if (cachedData) {
        this.log.info(`Cache HIT for key: ${cacheKey}`);
        return JSON.parse(cachedData);
      }

      this.log.info(`Cache MISS for key: ${cacheKey}`);
      return null;
    } catch (error) {
      this.log.error(`Error getting from Valkey cache: ${error.message}`);
      return null;
    }
  }

  /**
   * Set cached data for a file
   * @param {string} filePath - The file path to use as cache key
   * @param {object} data - The data to cache
   * @param {number} ttl - Time to live in seconds (optional, defaults to CACHE_TTL_SECONDS)
   * @returns {Promise<boolean>} - True if successfully cached, false otherwise
   */
  async set(filePath, data, ttl = CACHE_TTL_SECONDS) {
    // Lazy connect on first use
    await this.connect();
    if (!this.isConnected || !this.client) {
      this.log.warn('Valkey not connected, skipping cache set');
      return false;
    }

    try {
      const cacheKey = ValkeyCache.getCacheKey(filePath);
      this.log.info(`Setting Valkey cache for key: ${cacheKey} with TTL: ${ttl}s`);

      const serializedData = JSON.stringify(data);
      await this.client.setEx(cacheKey, ttl, serializedData);

      this.log.info(`Successfully cached data for key: ${cacheKey}`);
      return true;
    } catch (error) {
      this.log.error(`Error setting Valkey cache: ${error.message}`);
      return false;
    }
  }

  /**
   * Delete cached data for a file
   * @param {string} filePath - The file path to use as cache key
   * @returns {Promise<boolean>} - True if successfully deleted, false otherwise
   */
  async delete(filePath) {
    // Lazy connect on first use
    await this.connect();
    if (!this.isConnected || !this.client) {
      this.log.warn('Valkey not connected, skipping cache delete');
      return false;
    }

    try {
      const cacheKey = ValkeyCache.getCacheKey(filePath);
      this.log.info(`Deleting Valkey cache for key: ${cacheKey}`);

      await this.client.del(cacheKey);
      return true;
    } catch (error) {
      this.log.error(`Error deleting from Valkey cache: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear all cached data matching the LLMO cache pattern
   * Uses SCAN to safely iterate through keys without blocking Redis
   * @returns {Promise<{success: boolean, deletedCount: number}>} -
   * Result with success status and count of deleted keys
   */
  async clearAll() {
    // Lazy connect on first use
    await this.connect();
    if (!this.isConnected || !this.client) {
      this.log.warn('Valkey not connected, skipping cache clear');
      return { success: false, deletedCount: 0 };
    }

    try {
      const pattern = 'llmo:file:*';
      this.log.info(`Clearing all Valkey cache entries matching pattern: ${pattern}`);

      let cursor = 0;
      let deletedCount = 0;
      const keysToDelete = [];

      // Use SCAN to iterate through keys matching the pattern
      /* eslint-disable no-await-in-loop */
      do {
        const result = await this.client.scan(cursor, {
          MATCH: pattern,
          COUNT: 100, // Scan 100 keys at a time
        });

        cursor = result.cursor;
        const { keys } = result;

        if (keys.length > 0) {
          keysToDelete.push(...keys);
        }
      } while (cursor !== 0);
      /* eslint-enable no-await-in-loop */

      // Delete all found keys
      if (keysToDelete.length > 0) {
        this.log.info(`Found ${keysToDelete.length} keys to delete`);
        keysToDelete.forEach((key) => {
          this.log.info(`Deleting key: ${key}`);
        });
        // await this.client.del(keysToDelete);
        // deletedCount = keysToDelete.length;

        deletedCount = 0;
      }

      this.log.info(`Successfully cleared ${deletedCount} cache entries`);
      return { success: true, deletedCount };
    } catch (error) {
      this.log.error(`Error clearing Valkey cache: ${error.message}`);
      return { success: false, deletedCount: 0 };
    }
  }

  /**
   * Disconnect from Valkey
   */
  async disconnect() {
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
        this.log.info('Disconnected from Valkey');
      } catch (error) {
        this.log.error(`Error disconnecting from Valkey: ${error.message}`);
      }
    }
    this.isConnected = false;
    this.client = null;
  }
}

/**
 * Wrapper function to enable access to ElastiCache Valkey capabilities via the context.
 * When wrapped with this function, the cache is available as context.valkey.cache
 *
 * @param {UniversalAction} fn
 * @returns {function(object, UniversalContext): Promise<Response>}
 */
export function valkeyClientWrapper(fn) {
  return async (request, context) => {
    if (!context.valkey) {
      const { env, log } = context;

      // Create Valkey cache instance (connection is lazy - happens on first use)
      const cache = new ValkeyCache(env, log);

      context.valkey = {
        cache,
      };
    }
    return fn(request, context);
  };
}
