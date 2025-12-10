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

import CloudFrontCdnClient from './cloudfront-cdn-client.js';

/**
 * Registry for CDN clients
 * Manages different CDN provider implementations
 */
export default class CdnClientRegistry {
  constructor(env, log) {
    this.env = env;
    this.log = log;
    this.clients = new Map();
    this.#registerDefaultClients();
  }

  /**
   * Registers default CDN clients
   * @private
   */
  #registerDefaultClients() {
    this.registerClient('cloudfront', CloudFrontCdnClient);
  }

  /**
   * Registers a CDN client class
   * @param {string} provider - CDN provider name
   * @param {Class} ClientClass - CDN client class
   */
  registerClient(provider, ClientClass) {
    this.clients.set(provider.toLowerCase(), ClientClass);
  }

  /**
   * Gets a CDN client instance for the specified provider
   * @param {string} provider - CDN provider name
   * @param {Object} config - CDN configuration
   * @returns {BaseCdnClient|null} CDN client instance or null if not found
   */
  getClient(provider) {
    if (!provider) {
      this.log.warn('No CDN provider specified');
      return null;
    }

    const ClientClass = this.clients.get(provider.toLowerCase());

    if (!ClientClass) {
      this.log.warn(`No CDN client found for provider: ${provider}`);
      return null;
    }

    try {
      return new ClientClass(this.env, this.log);
    } catch (error) {
      this.log.error(`Failed to create CDN client for ${provider}: ${error.message}`, error);
      return null;
    }
  }

  /**
   * Gets list of supported CDN providers
   * @returns {Array<string>} List of provider names
   */
  getSupportedProviders() {
    return Array.from(this.clients.keys());
  }

  /**
   * Checks if a provider is supported
   * @param {string} provider - CDN provider name
   * @returns {boolean} True if provider is supported
   */
  isProviderSupported(provider) {
    return this.clients.has(provider?.toLowerCase());
  }
}
