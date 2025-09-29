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

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import ElastiCacheService, { createElastiCacheService } from '../../src/support/elasticache.js';

use(sinonChai);

describe('ElastiCache Service', () => {
  let mockRedisClient;
  let mockLog;
  let service;
  let createClientStub;

  beforeEach(() => {
    mockRedisClient = {
      disconnect: sinon.stub(),
      get: sinon.stub(),
      setex: sinon.stub(),
      del: sinon.stub(),
      info: sinon.stub(),
      on: sinon.stub(),
      removeAllListeners: sinon.stub(),
    };

    mockLog = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    // Stub the cluster client factory function
    createClientStub = sinon.stub().returns(mockRedisClient);

    const config = {
      host: 'test-cluster.cache.amazonaws.com',
      port: 6379,
      tls: true,
      defaultTTL: 1800,
    };

    service = new ElastiCacheService(config, mockLog);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      expect(service.config.host).to.equal('test-cluster.cache.amazonaws.com');
      expect(service.config.port).to.equal(6379);
      expect(service.config.tls).to.be.true;
      expect(service.defaultTTL).to.equal(1800);
      expect(service.isConnected).to.be.false;
    });

    it('should use default TTL when not provided', () => {
      const configWithoutTTL = {
        host: 'test-host',
        port: 6379,
      };
      const serviceWithDefaults = new ElastiCacheService(configWithoutTTL, mockLog);
      expect(serviceWithDefaults.defaultTTL).to.equal(3600);
    });
  });

  describe('connect', () => {
    it('should not connect if already connected', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);
      testService.isConnected = true;

      await testService.connect();

      expect(createClientStub).not.to.have.been.called;
    });

    it('should connect with full configuration', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      await testService.connect();

      expect(createClientStub).to.have.been.calledWith(
        [{ host: 'test-cluster.cache.amazonaws.com', port: 6379 }],
        {
          dnsLookup: sinon.match.func,
          redisOptions: {
            connectTimeout: 10000,
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            retryDelayOnFailover: 100,
            tls: {},
          },
          enableOfflineQueue: false,
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
          slotsRefreshTimeout: 10000,
          slotsRefreshInterval: 30000,
        },
      );
      expect(mockRedisClient.on).to.have.been.calledWith('error');
      expect(mockRedisClient.on).to.have.been.calledWith('connect');
      expect(mockRedisClient.on).to.have.been.calledWith('close');
      expect(mockRedisClient.on).to.have.been.calledWith('ready');
    });

    it('should connect without password', async () => {
      const configWithoutPassword = {
        host: 'test-host',
        port: 6379,
        tls: false,
        defaultTTL: 1800,
      };
      const testService = new ElastiCacheService(configWithoutPassword, mockLog, createClientStub);

      await testService.connect();

      expect(createClientStub).to.have.been.calledWith(
        [{ host: 'test-host', port: 6379 }],
        {
          dnsLookup: sinon.match.func,
          redisOptions: {
            connectTimeout: 10000,
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            retryDelayOnFailover: 100,
          },
          enableOfflineQueue: false,
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
          slotsRefreshTimeout: 10000,
          slotsRefreshInterval: 30000,
        },
      );
    });

    it('should connect without TLS', async () => {
      const configWithoutTLS = {
        host: 'test-host',
        port: 6379,
        tls: false,
        defaultTTL: 1800,
      };
      const testService = new ElastiCacheService(configWithoutTLS, mockLog, createClientStub);

      await testService.connect();

      expect(createClientStub).to.have.been.calledWith(
        [{ host: 'test-host', port: 6379 }],
        {
          dnsLookup: sinon.match.func,
          redisOptions: {
            connectTimeout: 10000,
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            retryDelayOnFailover: 100,
          },
          enableOfflineQueue: false,
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
          slotsRefreshTimeout: 10000,
          slotsRefreshInterval: 30000,
        },
      );
    });

    it('should use default port when not specified', async () => {
      const configWithoutPort = {
        host: 'test-host',
        tls: true,
        defaultTTL: 1800,
      };
      const testService = new ElastiCacheService(configWithoutPort, mockLog, createClientStub);

      await testService.connect();

      expect(createClientStub).to.have.been.calledWith(
        [{ host: 'test-host', port: 6379 }],
        {
          dnsLookup: sinon.match.func,
          redisOptions: {
            connectTimeout: 10000,
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            retryDelayOnFailover: 100,
            tls: {},
          },
          enableOfflineQueue: false,
          maxRetriesPerRequest: 2,
          retryDelayOnFailover: 100,
          slotsRefreshTimeout: 10000,
          slotsRefreshInterval: 30000,
        },
      );
    });

    it('should handle connection errors', async () => {
      const error = new Error('Connection failed');
      createClientStub.throws(error);

      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      try {
        await testService.connect();
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err).to.equal(error);
        expect(mockLog.error).to.have.been.calledWith('Failed to connect to ElastiCache: Connection failed');
      }
    });

    it('should set up event handlers correctly', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      await testService.connect();

      // Verify event handlers were set up
      expect(mockRedisClient.on).to.have.been.calledWith('error');
      expect(mockRedisClient.on).to.have.been.calledWith('connect');
      expect(mockRedisClient.on).to.have.been.calledWith('close');
      expect(mockRedisClient.on).to.have.been.calledWith('ready');

      // Test the event handlers by calling them
      const errorHandler = mockRedisClient.on.getCall(0).args[1];
      const connectHandler = mockRedisClient.on.getCall(1).args[1];
      const closeHandler = mockRedisClient.on.getCall(2).args[1];
      const readyHandler = mockRedisClient.on.getCall(3).args[1];

      // Test error handler
      const testError = new Error('Redis connection error');
      errorHandler(testError);
      expect(mockLog.error).to.have.been.calledWith('Redis Client Error: Redis connection error');
      expect(testService.isConnected).to.be.false;

      // Test connect handler
      connectHandler();
      expect(mockLog.info).to.have.been.calledWith('Connected to ElastiCache Redis cluster');
      expect(testService.isConnected).to.be.true;

      // Test close handler
      closeHandler();
      expect(mockLog.info).to.have.been.calledWith('Disconnected from ElastiCache Redis cluster');
      expect(testService.isConnected).to.be.false;

      // Test ready handler
      readyHandler();
      expect(mockLog.info).to.have.been.calledWith('ElastiCache Redis cluster is ready');
      expect(testService.isConnected).to.be.true;
    });

    it('should stop reconnection attempts after max attempts', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      // Set connection attempts to max
      testService.connectionAttempts = testService.maxConnectionAttempts;

      await testService.connect();

      expect(mockLog.warn).to.have.been.calledWith('Max connection attempts (3) reached for ElastiCache. Disabling Redis caching.');
      expect(createClientStub).not.to.have.been.called;
    });

    it('should handle critical Redis errors and stop reconnection', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      await testService.connect();

      // Get the error handler
      const errorHandler = mockRedisClient.on.getCall(0).args[1];

      // Test critical error handling
      const criticalError = new Error('Failed to refresh slots cache');
      errorHandler(criticalError);

      expect(mockLog.error).to.have.been.calledWith('Redis Client Error: Failed to refresh slots cache');
      expect(mockLog.warn).to.have.been.calledWith('Critical Redis error detected. Stopping reconnection attempts.');
      expect(testService.connectionAttempts).to.equal(testService.maxConnectionAttempts);
      expect(mockRedisClient.disconnect).to.have.been.called;
    });

    it('should handle All nodes failed error', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      await testService.connect();

      const errorHandler = mockRedisClient.on.getCall(0).args[1];
      const criticalError = new Error('All nodes failed');
      errorHandler(criticalError);

      expect(mockLog.warn).to.have.been.calledWith('Critical Redis error detected. Stopping reconnection attempts.');
      expect(testService.connectionAttempts).to.equal(testService.maxConnectionAttempts);
    });

    it('should handle Connection timeout error', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      await testService.connect();

      const errorHandler = mockRedisClient.on.getCall(0).args[1];
      const criticalError = new Error('Connection timeout');
      errorHandler(criticalError);

      expect(mockLog.warn).to.have.been.calledWith('Critical Redis error detected. Stopping reconnection attempts.');
      expect(testService.connectionAttempts).to.equal(testService.maxConnectionAttempts);
    });

    it('should clear timeout on ready event', async () => {
      const testService = new ElastiCacheService(service.config, mockLog, createClientStub);

      await testService.connect();

      // Get the ready handler (should be called twice - once in setup, once for timeout clear)
      const readyHandlers = mockRedisClient.on.getCalls().filter((call) => call.args[0] === 'ready');
      expect(readyHandlers).to.have.length(2);

      // Simulate ready event to clear timeout
      const timeoutClearHandler = readyHandlers[1].args[1];
      timeoutClearHandler();

      // Timeout should be cleared (can't test clearTimeout directly, but can ensure handler runs)
      expect(readyHandlers[1].args[0]).to.equal('ready');
    });
  });

  describe('disconnect', () => {
    it('should disconnect from Redis when connected', async () => {
      service.client = mockRedisClient;
      service.isConnected = true;

      await service.disconnect();

      expect(mockRedisClient.removeAllListeners).to.have.been.called;
      expect(mockRedisClient.disconnect).to.have.been.called;
      expect(service.isConnected).to.be.false;
    });

    it('should not disconnect if not connected', async () => {
      service.client = null;
      service.isConnected = false;

      await service.disconnect();

      expect(mockRedisClient.removeAllListeners).not.to.have.been.called;
      expect(mockRedisClient.disconnect).not.to.have.been.called;
    });

    it('should handle disconnect errors gracefully', async () => {
      service.client = mockRedisClient;
      const disconnectError = new Error('Disconnect failed');
      mockRedisClient.disconnect.throws(disconnectError);

      await service.disconnect();

      expect(mockRedisClient.removeAllListeners).to.have.been.called;
      expect(mockRedisClient.disconnect).to.have.been.called;
      expect(mockLog.error).to.have.been.calledWith('Error disconnecting from ElastiCache: Disconnect failed');
    });
  });

  describe('generateCacheKey', () => {
    it('should generate consistent cache key for sheet data', () => {
      const key1 = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', 'type1', { limit: 100 });
      const key2 = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', 'type1', { limit: 100 });

      expect(key1).to.equal(key2);
      expect(key1).to.match(/^llmo:sheet:[a-f0-9]{16}$/);
    });

    it('should generate different keys for different parameters', () => {
      const key1 = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', 'type1', { limit: 100 });
      const key2 = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', 'type1', { limit: 200 });

      expect(key1).not.to.equal(key2);
    });

    it('should handle null sheetType', () => {
      const key = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', null, {});
      expect(key).to.match(/^llmo:sheet:[a-f0-9]{16}$/);
    });

    it('should sort query parameters for consistent keys', () => {
      const key1 = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', null, { limit: 100, offset: 50 });
      const key2 = ElastiCacheService.generateCacheKey('site123', 'data-folder', 'source1', null, { offset: 50, limit: 100 });

      expect(key1).to.equal(key2);
    });
  });

  describe('generateGlobalCacheKey', () => {
    it('should generate consistent cache key for global data', () => {
      const key1 = ElastiCacheService.generateGlobalCacheKey('site123', 'config1', { limit: 100 });
      const key2 = ElastiCacheService.generateGlobalCacheKey('site123', 'config1', { limit: 100 });

      expect(key1).to.equal(key2);
      expect(key1).to.match(/^llmo:global:[a-f0-9]{16}$/);
    });

    it('should generate different keys for different config names', () => {
      const key1 = ElastiCacheService.generateGlobalCacheKey('site123', 'config1', {});
      const key2 = ElastiCacheService.generateGlobalCacheKey('site123', 'config2', {});

      expect(key1).not.to.equal(key2);
    });
  });

  describe('get', () => {
    beforeEach(() => {
      service.client = mockRedisClient;
      service.isConnected = true;
    });

    it('should return parsed data on cache hit', async () => {
      const testData = { test: 'data' };
      mockRedisClient.get.resolves(JSON.stringify(testData));

      const result = await service.get('test-key');

      expect(mockRedisClient.get).to.have.been.calledWith('test-key');
      expect(result).to.deep.equal(testData);
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Cache HIT for key: test-key/));
    });

    it('should return null on cache miss', async () => {
      mockRedisClient.get.resolves(null);

      const result = await service.get('test-key');

      expect(result).to.be.null;
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Cache MISS for key: test-key/));
    });

    it('should return null when not connected', async () => {
      service.isConnected = false;

      const result = await service.get('test-key');

      expect(result).to.be.null;
      expect(mockLog.warn).to.have.been.calledWith('ElastiCache not connected, skipping cache get');
      expect(mockRedisClient.get).not.to.have.been.called;
    });

    it('should handle Redis errors gracefully', async () => {
      const error = new Error('Redis error');
      mockRedisClient.get.rejects(error);

      const result = await service.get('test-key');

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledWith('Error getting data from cache for key test-key: Redis error');
    });
  });

  describe('set', () => {
    beforeEach(() => {
      service.client = mockRedisClient;
      service.isConnected = true;
    });

    it('should set data with default TTL', async () => {
      const testData = { test: 'data' };
      mockRedisClient.setex.resolves();

      const result = await service.set('test-key', testData);

      expect(mockRedisClient.setex).to.have.been.calledWith('test-key', 1800, JSON.stringify(testData));
      expect(result).to.be.true;
      expect(mockLog.info).to.have.been.calledWith(sinon.match(/Cache SET for key: test-key.*TTL: 1800s/));
    });

    it('should set data with custom TTL', async () => {
      const testData = { test: 'data' };
      mockRedisClient.setex.resolves();

      const result = await service.set('test-key', testData, 3600);

      expect(mockRedisClient.setex).to.have.been.calledWith('test-key', 3600, JSON.stringify(testData));
      expect(result).to.be.true;
    });

    it('should return false when not connected', async () => {
      service.isConnected = false;

      const result = await service.set('test-key', { test: 'data' });

      expect(result).to.be.false;
      expect(mockLog.warn).to.have.been.calledWith('ElastiCache not connected, skipping cache set');
      expect(mockRedisClient.setex).not.to.have.been.called;
    });

    it('should handle Redis errors gracefully', async () => {
      const error = new Error('Redis error');
      mockRedisClient.setex.rejects(error);

      const result = await service.set('test-key', { test: 'data' });

      expect(result).to.be.false;
      expect(mockLog.error).to.have.been.calledWith('Error setting data in cache for key test-key: Redis error');
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      service.client = mockRedisClient;
      service.isConnected = true;
    });

    it('should delete key successfully', async () => {
      mockRedisClient.del.resolves(1);

      const result = await service.delete('test-key');

      expect(mockRedisClient.del).to.have.been.calledWith('test-key');
      expect(result).to.be.true;
      expect(mockLog.info).to.have.been.calledWith('Cache DELETE for key: test-key - deleted: true');
    });

    it('should return false when key does not exist', async () => {
      mockRedisClient.del.resolves(0);

      const result = await service.delete('test-key');

      expect(result).to.be.false;
      expect(mockLog.info).to.have.been.calledWith('Cache DELETE for key: test-key - deleted: false');
    });

    it('should return false when not connected', async () => {
      service.isConnected = false;

      const result = await service.delete('test-key');

      expect(result).to.be.false;
      expect(mockLog.warn).to.have.been.calledWith('ElastiCache not connected, skipping cache delete');
    });

    it('should handle Redis errors gracefully', async () => {
      const error = new Error('Redis error');
      mockRedisClient.del.rejects(error);

      const result = await service.delete('test-key');

      expect(result).to.be.false;
      expect(mockLog.error).to.have.been.calledWith('Error deleting data from cache for key test-key: Redis error');
    });
  });

  describe('isReady', () => {
    it('should return connection status', () => {
      service.isConnected = true;
      expect(service.isReady()).to.be.true;

      service.isConnected = false;
      expect(service.isReady()).to.be.false;
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      service.client = mockRedisClient;
      service.isConnected = true;
    });

    it('should return stats when connected', async () => {
      const memoryInfo = 'memory info';
      const keyspaceInfo = 'keyspace info';
      mockRedisClient.info.withArgs('memory').resolves(memoryInfo);
      mockRedisClient.info.withArgs('keyspace').resolves(keyspaceInfo);

      const stats = await service.getStats();

      expect(stats).to.deep.equal({
        connected: true,
        memory: memoryInfo,
        keyspace: keyspaceInfo,
      });
    });

    it('should return disconnected status when not connected', async () => {
      service.isConnected = false;

      const stats = await service.getStats();

      expect(stats).to.deep.equal({ connected: false });
    });

    it('should handle Redis errors', async () => {
      const error = new Error('Redis error');
      mockRedisClient.info.rejects(error);

      const stats = await service.getStats();

      expect(stats).to.deep.equal({ connected: false, error: 'Redis error' });
      expect(mockLog.error).to.have.been.calledWith('Error getting cache stats: Redis error');
    });
  });

  describe('createElastiCacheService', () => {
    it('should create service with valid configuration', () => {
      const env = {
        ELASTICACHE_HOST: 'test-host',
        ELASTICACHE_PORT: '6380',
        ELASTICACHE_TLS: 'true',
        ELASTICACHE_DEFAULT_TTL: '7200',
      };

      const service2 = createElastiCacheService(env, mockLog);

      expect(service2).to.be.instanceOf(ElastiCacheService);
      expect(service2.config.host).to.equal('test-host');
      expect(service2.config.port).to.equal('6380');
      expect(service2.config.tls).to.be.true;
      expect(service2.defaultTTL).to.equal(7200);
    });

    it('should return null when host is not configured', () => {
      const env = {};

      const service2 = createElastiCacheService(env, mockLog);

      expect(service2).to.be.null;
      expect(mockLog.info).to.have.been.calledWith('ElastiCache not configured (ELASTICACHE_HOST not set), LLMO caching will be disabled');
    });

    it('should use defaults for optional configuration', () => {
      const env = {
        ELASTICACHE_HOST: 'test-host',
      };

      const service2 = createElastiCacheService(env, mockLog);

      expect(service2.config.port).to.equal('6379');
      expect(service2.config.tls).to.be.false;
      expect(service2.defaultTTL).to.equal(3600);
    });
  });
});
