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

/* eslint-disable */
/* eslint-env mocha */

import { expect } from 'chai';
import BaseCdnClient from '../../src/cdn/base-cdn-client.js';

describe('BaseCdnClient', () => {
  let client;

  beforeEach(() => {
    client = new BaseCdnClient({}, console);
  });

  describe('constructor', () => {
    it('should use console as default logger if log is not provided', () => {
      const clientWithoutLog = new BaseCdnClient({});
      expect(clientWithoutLog.log).to.equal(console);
    });
  });

  describe('abstract methods', () => {
    it('getProviderName should throw error', () => {
      expect(() => client.getProviderName())
        .to.throw('getProviderName() must be implemented by subclass');
    });

    it('validateConfig should throw error', () => {
      expect(() => client.validateConfig())
        .to.throw('validateConfig() must be implemented by subclass');
    });

    it('invalidateCache should throw error', async () => {
      try {
        await client.invalidateCache(['/test']);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('invalidateCache() must be implemented by subclass');
      }
    });
  });
});
