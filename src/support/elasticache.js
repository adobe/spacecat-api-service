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

import Redis from 'ioredis';
import crypto from 'crypto';

/**
 * ElastiCache service for caching LLMO sheet data
 */
class ElastiCacheService {
  constructor(config, log = console) {
    this.config = config;
    this.defaultTTL = config.defaultTTL || 3600; // 1 hour default
    this.log = log;
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.connectionTimeout = null;
  }

  /**
   * Connect to Redis cluster
   */
  async connect() {
    // Don't attempt connection if we've reached max attempts
    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      return;
    }

    // Don't connect if already connected
    if (this.isConnected && this.client) {
      return;
    }

    try {
      this.connectionAttempts += 1;

      // Initialize Redis cluster client
      const clusterNodes = [{
        host: this.config.host,
        port: this.config.port || 6379,
      }];

      const clusterOptions = {
        dnsLookup: (address, callback) => callback(null, address),
        enableAutoPipelining: true, // 35-50% performance improvement
        redisOptions: {
          connectTimeout: 10000, // 10 seconds
          lazyConnect: true, // Don't connect immediately
          maxRetriesPerRequest: 2, // Limit retries per request
          retryDelayOnFailover: 100,
        },
        enableOfflineQueue: false, // Don't queue commands when disconnected
        maxRetriesPerRequest: 2,
        retryDelayOnFailover: 100,
        slotsRefreshTimeout: 10000, // Timeout for slot refresh
        slotsRefreshInterval: 30000, // Interval for slot refresh
      };

      // Add TLS configuration for ElastiCache serverless
      if (this.config.tls) {
        clusterOptions.redisOptions.tls = {};
      }

      this.client = new Redis.Cluster(clusterNodes, clusterOptions);

      // Set up event handlers
      this.client.on('error', (error) => {
        this.isConnected = false;

        this.log.error(`ElastiCache connection failed: ${error.message}`);
        // Check for critical errors that should stop reconnection attempts
        if (error.message.includes('Failed to refresh slots cache')
          || error.message.includes('All nodes failed')
          || error.message.includes('Connection timeout')) {
          this.connectionAttempts = this.maxConnectionAttempts;
          this.disconnect();
        }
      });

      this.client.on('connect', () => {
        this.isConnected = true;
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });

      this.client.on('ready', () => {
        this.log.info('Connected to ElastiCache Redis cluster');
        this.isConnected = true;
      });

      // Set a timeout to prevent infinite connection attempts
      this.connectionTimeout = setTimeout(() => {
        if (!this.isConnected) {
          this.log.warn('ElastiCache connection failed: Connection timeout');
          this.disconnect();
        }
      }, 15000); // 15 seconds timeout

      // Clear timeout on ready
      this.client.on('ready', () => {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
      });
    } catch (error) {
      this.log.warn(`ElastiCache connection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    if (this.client) {
      try {
        // Clear connection timeout if it exists
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }

        // Remove event listeners to prevent memory leaks
        this.client.removeAllListeners();

        // Disconnect from Redis
        this.client.disconnect();
        this.isConnected = false;
      } catch (error) {
        // Silently handle disconnect errors
      }
    }
  }

  /**
   * Check if the cache service is ready
   */
  isReady() {
    return this.isConnected && this.client;
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    if (!this.isConnected || !this.client) {
      return { connected: false };
    }

    try {
      const memory = await this.client.info('memory');
      const keyspace = await this.client.info('keyspace');
      return {
        connected: true,
        memory,
        keyspace,
      };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  /**
                   * Generate a cache key for LLMO sheet data
                   * @param {string} siteId - The site ID
                   * @param {string} dataFolder - The data folder from LLMO config
                   * @param {string} dataSource - The data source name
                   * @param {string} sheetType - Optional sheet type
                   * @param {Object} queryParams - Query parameters (limit, offset, sheet)
                   * @returns {string} The cache key
                   */
  static generateCacheKey(siteId, dataFolder, dataSource, sheetType = null, queryParams = {}) {
    const sheetURL = sheetType
      ? `${dataFolder}/${sheetType}/${dataSource}.json`
      : `${dataFolder}/${dataSource}.json`;

    // Create a hash of query parameters for consistent key generation
    const queryString = Object.keys(queryParams)
      .sort()
      .map((key) => `${key}=${queryParams[key]}`)
      .join('&');

    const keyData = `${siteId}:${sheetURL}:${queryString}`;
    const hash = crypto.createHash('sha256').update(keyData).digest('hex').substring(0, 16);

    return `llmo:sheet:${hash}`;
  }

  /**
                   * Generate a cache key for LLMO global sheet data
                   * @param {string} siteId - The site ID
                   * @param {string} configName - The config name
                   * @param {Object} queryParams - Query parameters (limit, offset, sheet)
                   * @returns {string} The cache key
                   */
  static generateGlobalCacheKey(siteId, configName, queryParams = {}) {
    const sheetURL = `llmo-global/${configName}.json`;

    const queryString = Object.keys(queryParams)
      .sort()
      .map((key) => `${key}=${queryParams[key]}`)
      .join('&');

    const keyData = `${siteId}:${sheetURL}:${queryString}`;
    const hash = crypto.createHash('sha256').update(keyData).digest('hex').substring(0, 16);

    return `llmo:global:${hash}`;
  }

  /**
   * Get cached data
   * @param {string} key - The cache key
   * @returns {Object|null} The cached data or null if not found
   */
  async get(key) {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const cachedData = await this.client.get(key);
      return cachedData ? JSON.parse(cachedData) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Set cached data
   * @param {string} key - The cache key
   * @param {Object} data - The data to cache
   * @param {number} ttl - Time to live in seconds (optional)
   * @returns {boolean} True if successful, false otherwise
   */
  async set(key, data, ttl = null) {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      const serializedData = JSON.stringify(data);
      const expiration = ttl || this.defaultTTL;
      const result = await this.client.setex(key, expiration, serializedData);
      return result === 'OK';
    } catch (error) {
      return false;
    }
  }

  /**
   * Delete cached data
   * @param {string} key - The cache key
   * @returns {boolean} True if successful, false otherwise
   */
  async delete(key) {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      return false;
    }
  }
}

/**
 * Create ElastiCache service from environment configuration
 * @param {Object} env - Environment variables
 * @param {Object} log - Logger instance (optional)
 * @returns {ElastiCacheService} ElastiCache service instance
 */
export function createElastiCacheService(env, log) {
  const config = {
    host: env.ELASTICACHE_HOST || 'elmodata-u65bcl.serverless.use1.cache.amazonaws.com',
    port: env.ELASTICACHE_PORT || '6379',
    tls: env.ELASTICACHE_TLS === 'true',
    defaultTTL: parseInt(env.ELASTICACHE_DEFAULT_TTL || '3600', 10),
  };

  return new ElastiCacheService(config, log);
}

export default ElastiCacheService;
