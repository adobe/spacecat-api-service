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

/**
 * Base class for CDN clients
 * Defines the interface that all CDN-specific clients must implement
 */
export default class BaseCdnClient {
  constructor(env, log) {
    this.env = env;
    this.log = log || console;
  }

  /**
   * Returns the CDN provider name (e.g., 'akamai', 'cloudflare', 'fastly')
   * @returns {string} The CDN provider name
   */
  getProviderName() {
    this.log.error('getProviderName() must be implemented by subclass');
    throw new Error('getProviderName() must be implemented by subclass');
  }

  /**
   * Validates the CDN configuration
   * @returns {boolean} True if configuration is valid
   */
  validateConfig() {
    this.log.error('validateConfig() must be implemented by subclass');
    throw new Error('validateConfig() must be implemented by subclass');
  }

  /**
   * Invalidates the CDN cache for the given paths
   * @param {Array<string>} _ - Array of URL paths to invalidate
   * @returns {Promise<Object>} Result of the invalidation request
   */
  async invalidateCache(_) {
    this.log.error('invalidateCache() must be implemented by subclass');
    throw new Error('invalidateCache() must be implemented by subclass');
  }
}
