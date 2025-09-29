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
  constructor(config, log, clientFactory = null) {
    this.config = config;
    this.log = log;
    this.client = null;
    this.isConnected = false;
    this.defaultTTL = config.defaultTTL || 3600; // 1 hour default
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.reconnectBackoff = 1000; // Start with 1 second
    this.maxReconnectBackoff = 30000; // Max 30 seconds
    this.createClient = clientFactory
      || ((clusterNodes, options) => new Redis.Cluster(clusterNodes, options));
  }

  /**
                   * Initialize the Redis client connection
                   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      this.log.warn(`Max connection attempts (${this.maxConnectionAttempts}) reached for ElastiCache. Disabling Redis caching.`);
      return;
    }

    try {
      this.connectionAttempts += 1;

      // Configure cluster nodes
      const clusterNodes = [{
        host: this.config.host,
        port: this.config.port || 6379,
      }];

      // Configure cluster options with retry and timeout settings
      const clusterOptions = {
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: {
          connectTimeout: 10000, // 10 seconds
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
        },
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
        retryDelayOnFailover: 100,
        slotsRefreshTimeout: 10000,
        slotsRefreshInterval: 30000,
      };

      // Add TLS configuration for ElastiCache serverless
      if (this.config.tls) {
        clusterOptions.redisOptions.tls = {};
      }

      this.client = this.createClient(clusterNodes, clusterOptions);

      this.client.on('error', (err) => {
        this.log.error(`Redis Client Error: ${err.message}`);
        this.isConnected = false;

        // Prevent infinite reconnection loops
        if (err.message.includes('Failed to refresh slots cache')
          || err.message.includes('All nodes failed')
          || err.message.includes('Connection timeout')) {
          this.log.warn('Critical Redis error detected. Stopping reconnection attempts.');
          this.connectionAttempts = this.maxConnectionAttempts;
          if (this.client) {
            this.client.disconnect();
          }
        }
      });

      this.client.on('connect', () => {
        this.log.info('Connected to ElastiCache Redis cluster');
        this.isConnected = true;
        this.connectionAttempts = 0; // Reset on successful connection
      });

      this.client.on('close', () => {
        this.log.info('Disconnected from ElastiCache Redis cluster');
        this.isConnected = false;
      });

      // ioredis cluster connects automatically, no need to call connect()
      // Set connected status once cluster is ready
      this.client.on('ready', () => {
        this.isConnected = true;
        this.connectionAttempts = 0; // Reset on successful connection
        this.log.info('ElastiCache Redis cluster is ready');
      });

      // Add timeout for initial connection attempt
      const connectionTimeout = setTimeout(() => {
        if (!this.isConnected) {
          this.log.warn('ElastiCache connection timeout. Disconnecting...');
          if (this.client) {
            this.client.disconnect();
          }
        }
      }, 15000); // 15 seconds timeout

      this.client.on('ready', () => {
        clearTimeout(connectionTimeout);
      });
    } catch (error) {
      this.log.error(`Failed to connect to ElastiCache: ${error.message}`);
      throw error;
    }
  }

  /**
                   * Disconnect from Redis
                   */
  async disconnect() {
    if (this.client) {
      try {
        this.client.removeAllListeners();
        this.client.disconnect();
        this.isConnected = false;
        this.log.info('ElastiCache client disconnected successfully');
      } catch (error) {
        this.log.error(`Error disconnecting from ElastiCache: ${error.message}`);
      }
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
    if (!this.isConnected) {
      this.log.warn('ElastiCache not connected, skipping cache get');
      return null;
    }

    try {
      const startTime = Date.now();
      const cachedData = await this.client.get(key);
      const duration = Date.now() - startTime;

      if (cachedData) {
        this.log.info(`Cache HIT for key: ${key} - fetch duration: ${duration}ms`);
        return JSON.parse(cachedData);
      }
      this.log.info(`Cache MISS for key: ${key} - fetch duration: ${duration}ms`);
      return null;
    } catch (error) {
      this.log.error(`Error getting data from cache for key ${key}: ${error.message}`);
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
    if (!this.isConnected) {
      this.log.warn('ElastiCache not connected, skipping cache set');
      return false;
    }

    try {
      const startTime = Date.now();
      const serializedData = JSON.stringify(data);
      const expiration = ttl || this.defaultTTL;

      await this.client.setex(key, expiration, serializedData);
      const duration = Date.now() - startTime;

      this.log.info(`Cache SET for key: ${key} - duration: ${duration}ms, TTL: ${expiration}s, size: ${serializedData.length} bytes`);
      return true;
    } catch (error) {
      this.log.error(`Error setting data in cache for key ${key}: ${error.message}`);
      return false;
    }
  }

  /**
                   * Delete cached data
                   * @param {string} key - The cache key
                   * @returns {boolean} True if successful, false otherwise
                   */
  async delete(key) {
    if (!this.isConnected) {
      this.log.warn('ElastiCache not connected, skipping cache delete');
      return false;
    }

    try {
      const result = await this.client.del(key);
      this.log.info(`Cache DELETE for key: ${key} - deleted: ${result > 0}`);
      return result > 0;
    } catch (error) {
      this.log.error(`Error deleting data from cache for key ${key}: ${error.message}`);
      return false;
    }
  }

  /**
                   * Check if the service is connected
                   * @returns {boolean} True if connected, false otherwise
                   */
  isReady() {
    return this.isConnected;
  }

  /**
                   * Get cache statistics
                   * @returns {Object} Cache statistics
                   */
  async getStats() {
    if (!this.isConnected) {
      return { connected: false };
    }

    try {
      const info = await this.client.info('memory');
      const keyspace = await this.client.info('keyspace');

      return {
        connected: true,
        memory: info,
        keyspace,
      };
    } catch (error) {
      this.log.error(`Error getting cache stats: ${error.message}`);
      return { connected: false, error: error.message };
    }
  }
}

/**
 * Create ElastiCache service from environment configuration
 * @param {Object} env - Environment variables
 * @param {Object} log - Logger instance
 * @returns {ElastiCacheService|null} ElastiCache service instance or null if not configured
 */
export function createElastiCacheService(env, log) {
  // Only create service if host is explicitly configured
  if (!env.ELASTICACHE_HOST) {
    log.info('ElastiCache not configured (ELASTICACHE_HOST not set), LLMO caching will be disabled');
    return null;
  }

  const config = {
    host: env.ELASTICACHE_HOST || 'elmodata-u65bcl.serverless.use1.cache.amazonaws.com',
    port: env.ELASTICACHE_PORT || '6379',
    tls: env.ELASTICACHE_TLS === 'true',
    defaultTTL: parseInt(env.ELASTICACHE_DEFAULT_TTL || '3600', 10),
  };

  return new ElastiCacheService(config, log);
}

export default ElastiCacheService;
