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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { brotliCompressSync, brotliDecompressSync } from 'zlib';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

describe('Valkey cache tests', () => {
  let sandbox;
  let mockRedisClient;
  let mockCreateClient;
  let ValkeyModule;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Create a mock Redis client with all necessary methods
    // Store event handlers for testing
    const eventHandlers = {};
    mockRedisClient = {
      connect: sandbox.stub().resolves(),
      get: sandbox.stub(),
      setEx: sandbox.stub().resolves(),
      quit: sandbox.stub().resolves(),
      on: sandbox.spy((event, handler) => {
        eventHandlers[event] = handler;
        return mockRedisClient;
      }),
    };
    // Attach eventHandlers to mockRedisClient for test access
    mockRedisClient.testEventHandlers = eventHandlers;

    // Mock createClient to return our mock client
    mockCreateClient = sandbox.stub().returns(mockRedisClient);

    // Import the module with mocked redis client
    // Use a fresh import each time to avoid state issues
    ValkeyModule = await esmock('../../src/support/valkey.js', {
      redis: {
        createClient: mockCreateClient,
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('valkeyClientWrapper', () => {
    let mockRequest;
    let mockContext;
    let exampleHandler;

    beforeEach(() => {
      mockRequest = {};
      mockContext = {
        log: {
          info: sandbox.stub(),
          warn: sandbox.stub(),
          error: sandbox.stub(),
        },
        env: {
          VALKEY_HOST: 'test-host.example.com',
          VALKEY_PORT: '6379',
        },
      };

      exampleHandler = sinon.spy(async (message, context) => {
        const { log } = context;
        const messageStr = JSON.stringify(message);
        log.info(`Handling message ${messageStr}`);
        return new Response(messageStr);
      });
    });

    it('should add valkey cache to the context', async () => {
      expect(mockContext.valkey).to.be.undefined;

      await ValkeyModule.valkeyClientWrapper(exampleHandler)(mockRequest, mockContext);

      expect(exampleHandler.calledOnce).to.be.true;
      const firstCall = exampleHandler.getCall(0);

      // Check the context object passed to the handler
      expect(firstCall.args[1].valkey).to.be.an('object');
      expect(firstCall.args[1].valkey.cache).to.be.an('object');
      expect(firstCall.args[1].valkey.cache.get).to.be.a('function');
      expect(firstCall.args[1].valkey.cache.set).to.be.a('function');
    });

    it('does not create a new valkey cache if one already exists in the context', async () => {
      const existingCache = {
        get: sandbox.stub(),
        set: sandbox.stub(),
      };
      mockContext.valkey = {
        cache: existingCache,
      };

      await ValkeyModule.valkeyClientWrapper(exampleHandler)(mockRequest, mockContext);

      expect(exampleHandler.calledOnce).to.be.true;
      const secondParam = exampleHandler.getCall(0).args[1];
      expect(secondParam.valkey.cache).to.equal(existingCache);
    });
  });

  describe('ValkeyCache', () => {
    let cache;
    let mockLog;
    let mockEnv;

    beforeEach(() => {
      mockLog = {
        info: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      };

      mockEnv = {
        VALKEY_HOST: 'test-host.example.com',
        VALKEY_PORT: '6379',
      };

      cache = new ValkeyModule.ValkeyCache(mockEnv, mockLog);
    });

    describe('getCacheKey', () => {
      it('should generate correct cache key for file path', () => {
        const filePath = 'test/folder/file.json';
        const key = ValkeyModule.ValkeyCache.getCacheKey(filePath);
        expect(key).to.equal('llmo:file:test/folder/file.json');
      });
    });

    describe('connect', () => {
      it('should connect to Valkey successfully', async () => {
        await cache.connect();

        expect(mockCreateClient).to.have.been.calledOnce;
        expect(mockRedisClient.connect).to.have.been.calledOnce;
        expect(mockRedisClient.on).to.have.been.calledWith('error');
        expect(mockRedisClient.on).to.have.been.calledWith('connect');
        expect(mockRedisClient.on).to.have.been.calledWith('disconnect');
        expect(cache.isConnected).to.be.true;
      });

      it('should not reconnect if already connected', async () => {
        await cache.connect();
        sandbox.resetHistory();

        await cache.connect();

        expect(mockCreateClient).to.not.have.been.called;
        expect(mockRedisClient.connect).to.not.have.been.called;
      });

      it('should handle connection errors gracefully', async () => {
        mockRedisClient.connect.rejects(new Error('Connection failed'));

        await cache.connect();

        expect(mockLog.error).to.have.been.calledWithMatch(/Failed to connect to Valkey/);
        expect(cache.isConnected).to.be.false;
        expect(cache.client).to.be.null;
      });

      it('should use default host and port if not provided', async () => {
        mockCreateClient.resetHistory();
        const cacheWithDefaults = new ValkeyModule.ValkeyCache({}, mockLog);

        await cacheWithDefaults.connect();

        expect(mockCreateClient).to.have.been.calledOnce;
        const createClientCall = mockCreateClient.getCall(0);
        expect(createClientCall.args[0].socket.host).to.equal('elmodata-u65bcl.serverless.use1.cache.amazonaws.com');
        expect(createClientCall.args[0].socket.port).to.equal(6379);
      });

      it('should handle reconnectStrategy when retries exceed limit', async () => {
        await cache.connect();

        // Get the reconnectStrategy function from the createClient call
        const createClientCall = mockCreateClient.getCall(0);
        const { reconnectStrategy } = createClientCall.args[0].socket;

        // Test with retries > 1 (should stop reconnecting)
        const result = reconnectStrategy(2);

        expect(result).to.be.false;
        expect(mockLog.error).to.have.been.calledWithMatch(/Max Valkey reconnection attempts reached/);
      });

      it('should handle reconnectStrategy when retries are within limit', async () => {
        await cache.connect();

        // Get the reconnectStrategy function from the createClient call
        const createClientCall = mockCreateClient.getCall(0);
        const { reconnectStrategy } = createClientCall.args[0].socket;

        // Test with retries <= 1 (should continue reconnecting)
        const result1 = reconnectStrategy(0);
        const result2 = reconnectStrategy(1);

        expect(result1).to.equal(0);
        expect(result2).to.equal(100);
        expect(mockLog.error).to.not.have.been.calledWithMatch(/Max Valkey reconnection attempts reached/);
      });
    });

    describe('get', () => {
      it('should return cached data when found', async () => {
        const filePath = 'test/file.json';
        const testData = { key: 'value', data: [1, 2, 3] };
        const serialized = JSON.stringify(testData);
        const compressed = brotliCompressSync(Buffer.from(serialized));
        const base64Data = compressed.toString('base64');

        mockRedisClient.get.resolves(base64Data);

        await cache.connect();
        const result = await cache.get(filePath);

        expect(result).to.deep.equal(testData);
        expect(mockRedisClient.get).to.have.been.calledWith('llmo:file:test/file.json');
        expect(mockLog.info).to.have.been.calledWithMatch(/Cache HIT/);
      });

      it('should return null when cache miss', async () => {
        const filePath = 'test/file.json';

        mockRedisClient.get.resolves(null);

        await cache.connect();
        const result = await cache.get(filePath);

        expect(result).to.be.null;
        expect(mockLog.info).to.have.been.calledWithMatch(/Cache MISS/);
      });

      it('should return null when not connected', async () => {
        const filePath = 'test/file.json';

        // Force connection to fail
        mockRedisClient.connect.rejects(new Error('Connection failed'));
        cache.client = null;
        cache.isConnected = false;

        const result = await cache.get(filePath);

        expect(result).to.be.null;
        expect(mockLog.warn).to.have.been.calledWithMatch(/Valkey not connected/);
        expect(mockRedisClient.get).to.not.have.been.called;
      });

      it('should handle errors gracefully', async () => {
        const filePath = 'test/file.json';

        mockRedisClient.get.rejects(new Error('Redis error'));

        await cache.connect();
        const result = await cache.get(filePath);

        expect(result).to.be.null;
        expect(mockLog.error).to.have.been.calledWithMatch(/Error getting from Valkey cache/);
      });
    });

    describe('set', () => {
      it('should cache data successfully', async () => {
        const filePath = 'test/file.json';
        const testData = { key: 'value', data: [1, 2, 3] };
        const ttl = 3600;

        await cache.connect();
        const result = await cache.set(filePath, testData, ttl);

        expect(result).to.be.true;
        expect(mockRedisClient.setEx).to.have.been.calledOnce;

        const [key, ttlValue, value] = mockRedisClient.setEx.getCall(0).args;
        expect(key).to.equal('llmo:file:test/file.json');
        expect(ttlValue).to.equal(ttl);

        // Verify the value is base64 encoded compressed data
        expect(value).to.be.a('string');
        const buffer = Buffer.from(value, 'base64');
        const decompressed = brotliDecompressSync(buffer);
        const parsed = JSON.parse(decompressed.toString('utf8'));
        expect(parsed).to.deep.equal(testData);
      });

      it('should use default TTL when not provided', async () => {
        const filePath = 'test/file.json';
        const testData = { key: 'value' };

        await cache.connect();
        await cache.set(filePath, testData);

        const [, ttlValue] = mockRedisClient.setEx.getCall(0).args;
        expect(ttlValue).to.equal(2 * 60 * 60); // CACHE_TTL_SECONDS
      });

      it('should return false when not connected', async () => {
        const filePath = 'test/file.json';
        const testData = { key: 'value' };

        // Ensure cache is not connected and make connect() fail
        cache.client = null;
        cache.isConnected = false;
        mockRedisClient.connect.rejects(new Error('Connection failed'));

        const result = await cache.set(filePath, testData);

        expect(result).to.be.false;
        expect(mockLog.warn).to.have.been.calledWithMatch(/Valkey not connected/);
        expect(mockRedisClient.setEx).to.not.have.been.called;
      });

      it('should handle errors gracefully', async () => {
        const filePath = 'test/file.json';
        const testData = { key: 'value' };

        mockRedisClient.setEx.rejects(new Error('Redis error'));

        await cache.connect();
        const result = await cache.set(filePath, testData);

        expect(result).to.be.false;
        expect(mockLog.error).to.have.been.calledWithMatch(/Error setting Valkey cache/);
      });
    });

    describe('disconnect', () => {
      it('should disconnect from Valkey successfully', async () => {
        await cache.connect();
        await cache.disconnect();

        expect(mockRedisClient.quit).to.have.been.calledOnce;
        expect(mockLog.info).to.have.been.calledWithMatch(/Disconnected from Valkey/);
        expect(cache.isConnected).to.be.false;
        expect(cache.client).to.be.null;
      });

      it('should handle disconnect errors gracefully', async () => {
        mockRedisClient.quit.rejects(new Error('Disconnect failed'));

        await cache.connect();
        await cache.disconnect();

        expect(mockLog.error).to.have.been.calledWithMatch(/Error disconnecting from Valkey/);
        expect(cache.isConnected).to.be.false;
      });

      it('should not attempt disconnect if not connected', async () => {
        await cache.disconnect();

        expect(mockRedisClient.quit).to.not.have.been.called;
      });
    });

    describe('event handlers', () => {
      it('should register error event handler', async () => {
        await cache.connect();

        expect(mockRedisClient.on).to.have.been.called;
        const errorCall = mockRedisClient.on.getCalls().find(
          (call) => call.args[0] === 'error' && typeof call.args[1] === 'function',
        );
        expect(errorCall).to.exist;
      });

      it('should register connect event handler', async () => {
        await cache.connect();

        expect(mockRedisClient.on).to.have.been.called;
        const connectCall = mockRedisClient.on.getCalls().find(
          (call) => call.args[0] === 'connect' && typeof call.args[1] === 'function',
        );
        expect(connectCall).to.exist;
      });

      it('should register disconnect event handler', async () => {
        await cache.connect();

        expect(mockRedisClient.on).to.have.been.called;
        const disconnectCall = mockRedisClient.on.getCalls().find(
          (call) => call.args[0] === 'disconnect' && typeof call.args[1] === 'function',
        );
        expect(disconnectCall).to.exist;
      });

      it('should handle error events when triggered', async () => {
        await cache.connect();
        sandbox.resetHistory();

        // Get the error handler from stored event handlers
        const errorCallback = mockRedisClient.testEventHandlers.error;
        expect(errorCallback).to.exist;
        cache.isConnected = true;
        errorCallback(new Error('Test error'));

        expect(mockLog.error).to.have.been.calledWithMatch(/Valkey client error/);
        expect(cache.isConnected).to.be.false;
      });

      it('should handle connect events when triggered', async () => {
        await cache.connect();
        sandbox.resetHistory();

        // Get the connect handler from stored event handlers
        const connectCallback = mockRedisClient.testEventHandlers.connect;
        expect(connectCallback).to.exist;
        connectCallback();

        expect(mockLog.info).to.have.been.calledWithMatch(/Valkey client connected/);
      });

      it('should handle disconnect events when triggered', async () => {
        await cache.connect();
        sandbox.resetHistory();

        // Get the disconnect handler from stored event handlers
        const disconnectCallback = mockRedisClient.testEventHandlers.disconnect;
        expect(disconnectCallback).to.exist;
        cache.isConnected = true;
        disconnectCallback();

        expect(mockLog.warn).to.have.been.calledWithMatch(/Valkey client disconnected/);
        expect(cache.isConnected).to.be.false;
      });
    });

    describe('clearAll', () => {
      beforeEach(() => {
        // Add scan and del methods to mockRedisClient
        mockRedisClient.scan = sandbox.stub();
        mockRedisClient.del = sandbox.stub().resolves(1);
      });

      it('should clear all cache entries successfully', async () => {
        const keys = ['llmo:file:test1.json', 'llmo:file:test2.json', 'llmo:file:test3.json'];

        // Mock scan to return keys on first call, then return cursor 0 to stop
        mockRedisClient.scan
          .onFirstCall().resolves({ cursor: 0, keys })
          .onSecondCall().resolves({ cursor: 0, keys: [] });

        await cache.connect();
        const result = await cache.clearAll();

        expect(result.success).to.be.true;
        expect(result.deletedCount).to.equal(0);
        expect(mockRedisClient.scan).to.have.been.calledWith(0, {
          MATCH: 'llmo:file:*',
          COUNT: 100,
        });
        expect(mockRedisClient.del).to.have.been.calledThrice;
        expect(mockLog.info).to.have.been.calledWithMatch(/Clearing all Valkey cache entries/);
      });

      it('should handle deletion errors gracefully', async () => {
        const keys = ['llmo:file:test1.json', 'llmo:file:test2.json'];
        mockRedisClient.scan.resolves({ cursor: 0, keys });
        mockRedisClient.del.rejects(new Error('Delete failed'));

        await cache.connect();
        const result = await cache.clearAll();

        expect(result.success).to.be.false;
        expect(result.deletedCount).to.equal(0);
        expect(mockLog.error).to.have.been.calledWithMatch(/Error clearing Valkey cache/);
      });
    });
  });
});
