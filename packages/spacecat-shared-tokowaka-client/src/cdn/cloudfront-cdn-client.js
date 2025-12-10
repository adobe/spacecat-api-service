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

import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import BaseCdnClient from './base-cdn-client.js';

/**
 * CloudFront CDN client implementation
 * Handles cache invalidation for AWS CloudFront
 */
export default class CloudFrontCdnClient extends BaseCdnClient {
  constructor(env, log) {
    super(env, log);
    let parsedConfig = {};
    try {
      parsedConfig = JSON.parse(env.TOKOWAKA_CDN_CONFIG);
    } catch (e) {
      throw new Error('Invalid TOKOWAKA_CDN_CONFIG: must be valid JSON');
    }

    if (!parsedConfig.cloudfront) {
      throw new Error("Missing 'cloudfront' config in TOKOWAKA_CDN_CONFIG");
    }

    this.cdnConfig = parsedConfig.cloudfront;
    this.client = null;
    this.providerName = 'cloudfront';
  }

  getProviderName() {
    return this.providerName;
  }

  validateConfig() {
    // Only distributionId is required - credentials are optional when running on Lambda
    if (!this.cdnConfig.distributionId || !this.cdnConfig.region) {
      this.log.error('CloudFront CDN config missing required fields: distributionId and region');
      return false;
    }

    return true;
  }

  /**
   * Initializes the CloudFront client
   * @private
   */
  #initializeClient() {
    if (!this.client) {
      this.client = new CloudFrontClient({
        region: this.cdnConfig.region,
      });
    }
  }

  /**
   * Invalidates CloudFront CDN cache for given paths
   * @param {Array<string>} paths - Array of URL paths to invalidate
   * @returns {Promise<Object>} Result of the invalidation request
   */
  async invalidateCache(paths) {
    if (!this.validateConfig()) {
      throw new Error('Invalid CloudFront CDN configuration');
    }

    if (!Array.isArray(paths) || paths.length === 0) {
      this.log.warn('No paths provided for cache invalidation');
      return { status: 'skipped', message: 'No paths to invalidate' };
    }

    this.#initializeClient();

    // CloudFront requires paths to start with '/'
    const formattedPaths = paths.map((path) => {
      if (!path.startsWith('/')) {
        return `/${path}`;
      }
      return path;
    });

    const callerReference = `tokowaka-${Date.now()}`;

    const command = new CreateInvalidationCommand({
      DistributionId: this.cdnConfig.distributionId,
      InvalidationBatch: {
        CallerReference: callerReference,
        Paths: {
          Quantity: formattedPaths.length,
          Items: formattedPaths,
        },
      },
    });

    this.log.debug(`Initiating CloudFront cache invalidation for ${JSON.stringify(formattedPaths)} paths`);
    const startTime = Date.now();

    try {
      const response = await this.client.send(command);
      const invalidation = response.Invalidation;

      this.log.info(`CloudFront cache invalidation initiated: ${invalidation.Id} (took ${Date.now() - startTime}ms)`);

      return {
        status: 'success',
        provider: 'cloudfront',
        invalidationId: invalidation.Id,
        invalidationStatus: invalidation.Status,
        createTime: invalidation.CreateTime,
        paths: formattedPaths.length,
      };
    } catch (error) {
      this.log.error(`Failed to invalidate CloudFront cache after ${Date.now() - startTime}ms: ${error.message}`, error);
      throw error;
    }
  }
}
