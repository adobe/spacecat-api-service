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
  badRequest,
  internalServerError,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { createHash } from 'crypto';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { FixDto } from '../../dto/fix.js';

/**
 * Handler for applying accessibility fixes.
 * Handles the complete flow of applying accessibility fixes including:
 * - S3 operations for fix files
 * - AIO app integration for PR creation
 * - Suggestion grouping and matching
 */
export class ApplyAccessibilityFixHandler {
  /** @type {import("@adobe/spacecat-shared-data-access").FixEntityCollection} */
  #FixEntity;

  /** @type {import("@adobe/spacecat-shared-data-access").SuggestionCollection} */
  #Suggestion;

  /**
   * @param {Object} dataAccess - Data access collections
   */
  constructor(dataAccess) {
    this.#FixEntity = dataAccess.FixEntity;
    this.#Suggestion = dataAccess.Suggestion;
  }

  /**
   * Applies accessibility fixes for the given suggestions.
   *
   * @param {Object} context - Request context
   * @param {string[]} suggestionIds - Array of suggestion IDs to apply fixes for
   * @param {Object} opportunity - The opportunity entity
   * @param {Object} site - The site entity
   * @returns {Promise<Response>} Response indicating success or failure
   */
  async applyFixes(context, suggestionIds, opportunity, site) {
    const {
      log, env, imsClient, s3,
    } = context;
    const asoPrHandlerUrl = '/api/v1/web/aem-sites-optimizer-gh-app/pull-request-handler';

    // Validate all suggestion IDs are valid UUIDs
    for (const id of suggestionIds) {
      if (!isValidUUID(id)) {
        return badRequest(`Invalid suggestion ID format: ${id}`);
      }
    }

    const { ASO_APP_URL, S3_MYSTIQUE_BUCKET_NAME } = env;
    // TODO: Remove hardcoded once appended in secrets
    const asoAppUrl = ASO_APP_URL || 'https://283250-asosampleapp-stage.adobeioruntime.net';
    const mystiqueBucket = S3_MYSTIQUE_BUCKET_NAME || 'spacecat-dev-mystique-assets';

    if (!s3 || !s3.s3Client) {
      log.error('S3 client is not available in context');
      return internalServerError('S3 service is not configured');
    }

    try {
      const repoUrl = site.getGitHubURL();
      if (!hasText(repoUrl)) {
        return badRequest('Site must have a GitHub repository URL configured');
      }

      // Get the organization to access IMS org ID
      const organization = await site.getOrganization();
      if (!organization || !organization.getImsOrgId()) {
        return badRequest('Site must belong to an organization with IMS Org ID');
      }

      // Fetch all suggestions by their IDs
      const suggestions = await Promise.all(
        suggestionIds.map((id) => this.#Suggestion.findById(id)),
      );

      // Validate that all suggestions exist and belong to the opportunity
      const opportunityId = opportunity.getId();
      for (let i = 0; i < suggestions.length; i += 1) {
        const suggestion = suggestions[i];
        if (!suggestion) {
          return notFound(`Suggestion not found: ${suggestionIds[i]}`);
        }
        if (suggestion.getOpportunityId() !== opportunityId) {
          return badRequest(`Suggestion ${suggestionIds[i]} does not belong to opportunity ${opportunityId}`);
        }
      }

      // Group suggestions by URL and source
      const groupedSuggestions = this.#groupSuggestionsByUrlSource(suggestions);

      if (groupedSuggestions.size === 0) {
        return badRequest('No valid suggestions with URL and source found');
      }

      const results = [];
      const { s3Client } = s3;
      const siteId = site.getId();

      // Process each group
      for (const [hashKey, group] of groupedSuggestions) {
        const { url, source, suggestions: groupSuggestions } = group;

        log.info(`Processing group for URL: ${url}, Source: ${source}, Hash: ${hashKey}`);

        // Look for fixes in S3 bucket
        const s3Prefix = `fixes/${siteId}/${hashKey}/`;
        // eslint-disable-next-line no-await-in-loop
        const s3Objects = await this.#listS3Objects(s3Client, mystiqueBucket, s3Prefix);

        if (s3Objects.length === 0) {
          log.warn(`No fixes found in S3 for hash key: ${hashKey}`);
          // eslint-disable-next-line no-continue
          continue;
        }

        // Find report.json files in subfolders
        const reportFiles = s3Objects.filter((key) => key.endsWith('/report.json'));

        for (const reportPath of reportFiles) {
          // eslint-disable-next-line no-await-in-loop
          const report = await this.#readJsonFromS3(
            s3Client,
            mystiqueBucket,
            reportPath,
          );

          if (!report) {
            log.warn(`Failed to read report.json from: ${reportPath}`);
            // eslint-disable-next-line no-continue
            continue;
          }

          // TODO: improve logic to get fix
          const matchingSuggestions = groupSuggestions.filter((suggestion) => {
            const suggestionData = suggestion.getData();
            return suggestionData.issues
              && suggestionData.issues.some((issue) => issue.type === report.type);
          });

          if (matchingSuggestions.length === 0) {
            // eslint-disable-next-line no-continue
            continue;
          }

          // Get the assets folder path
          const assetsFolderPath = reportPath.replace('/report.json', '/assets/');

          // Read all files from the assets folder
          const assetFiles = s3Objects.filter(
            (key) => key.startsWith(assetsFolderPath) && key !== assetsFolderPath,
          );
          const updatedFiles = [];
          for (const assetPath of assetFiles) {
            const relativePath = assetPath.replace(assetsFolderPath, '');
            if (report.updatedFiles && report.updatedFiles.includes(relativePath)) {
              // eslint-disable-next-line no-await-in-loop
              const content = await this.#readFileFromS3(
                s3Client,
                mystiqueBucket,
                assetPath,
              );
              if (content) {
                updatedFiles.push({
                  path: relativePath,
                  content,
                });
              }
            }
          }

          if (updatedFiles.length === 0) {
            log.warn(`No updated files found for report: ${reportPath}`);
            // eslint-disable-next-line no-continue
            continue;
          }

          // Create description from the first matching suggestion's issues
          const firstSuggestion = matchingSuggestions[0];
          const suggestionData = firstSuggestion.getData();
          const matchingIssue = suggestionData.issues.find(
            (issue) => issue.type === report.type,
          );
          const description = matchingIssue?.description;

          // Prepare payload for AIO app
          const aioPayload = {
            title: description,
            vcsType: 'github',
            updatedFiles,
            repoURL: repoUrl,
          };

          // Get service access token from IMS client
          // eslint-disable-next-line no-await-in-loop
          const serviceToken = await this.#getServiceAccessToken(imsClient, env, log);
          if (!serviceToken) {
            log.error('Failed to obtain service access token from IMS');
            return internalServerError('Authentication failed');
          }

          // Make request to AIO app
          // eslint-disable-next-line no-await-in-loop
          const aioResponse = await fetch(asoAppUrl + asoPrHandlerUrl, {
            method: 'POST',
            headers: {
              'x-gw-ims-org-id': organization.getImsOrgId(),
              'Content-Type': 'application/json',
              Authorization: `Bearer ${serviceToken}`,
            },
            body: JSON.stringify(aioPayload),
          });

          if (!aioResponse.ok) {
            log.error(`AIO app request failed: ${aioResponse.status} ${aioResponse.statusText}`);
            // eslint-disable-next-line no-await-in-loop
            const errorText = await aioResponse.text();
            log.error(`AIO app error response: ${errorText}`);
            results.push({
              success: false,
              type: report.type,
              message: `AIO app returned ${aioResponse.status}: ${aioResponse.statusText}`,
            });
            // eslint-disable-next-line no-continue
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const aioResult = await aioResponse.json();
          log.info(`Successfully applied accessibility fix for type: ${report.type}, URL: ${url}, Source: ${source}`);

          // Create FixEntity after successful PR creation
          const fixEntityData = {
            opportunityId,
            type: 'CODE_CHANGE',
            status: 'PENDING',
            changeDetails: {
              pullRequestUrl: aioResult.pullRequest,
              updatedFiles: updatedFiles.map((f) => f.path),
            },
          };
          // eslint-disable-next-line no-await-in-loop
          const createdFix = await this.#createEntityAndUpdateSuggestions(
            matchingSuggestions,
            fixEntityData,
          );

          results.push({
            success: true,
            type: report.type,
            pullRequestUrl: aioResult.pullRequest,
            fixId: createdFix.getId(),
            fix: FixDto.toJSON(createdFix),
          });
        }
      }

      if (results.length === 0) {
        return badRequest('No matching fixes found in S3 for the provided suggestions');
      }

      const successfulResults = results.filter((r) => r.success);
      const failedResults = results.filter((r) => !r.success);

      return ok({
        fixes: results.map((result, index) => ({
          index,
          statusCode: result.success ? 200 : 400,
          ...(result.success ? {
            fix: result.fix,
          } : {
            message: result.message,
          }),
        })),
        metadata: {
          total: results.length,
          success: successfulResults.length,
          failure: failedResults.length,
        },
      });
    } catch (error) {
      log.error(`Error applying accessibility fix ${error.message}`);
      return internalServerError('Failed to apply accessibility fix');
    }
  }

  /**
   * Creates a FixEntity and updates the associated suggestions.
   * @param {Array} suggestions - Array of suggestion entities
   * @param {Object} fixEntityData - Data for creating the fix entity
   * @returns {Promise<Object>} Created fix entity
   * @private
   */
  async #createEntityAndUpdateSuggestions(suggestions, fixEntityData) {
    const createdFix = await this.#FixEntity.create(fixEntityData);
    const fixId = createdFix.getId();

    for (const suggestion of suggestions) {
      suggestion.setFixEntityId(fixId);
      // eslint-disable-next-line no-await-in-loop
      await suggestion.save();
    }

    return createdFix;
  }

  /**
   * Generates a hash key from URL and source combination.
   * @param {string} url - The URL.
   * @param {string} source - The source.
   * @returns {string} MD5 hash of the combined URL and source (first 16 characters).
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  #generateUrlSourceHash(url, source) {
    const combined = `${url}_${source}`;
    return createHash('md5').update(combined).digest('hex').substring(0, 16);
  }

  /**
   * Groups suggestions by URL and source.
   * @param {Array} suggestions - Array of suggestion objects.
   * @returns {Map} Map with hash keys and grouped suggestions.
   * @private
   */
  #groupSuggestionsByUrlSource(suggestions) {
    const groupedSuggestions = new Map();

    for (const suggestion of suggestions) {
      const { url, source } = suggestion.getData();
      if (!url || !source) {
        // eslint-disable-next-line no-continue
        continue;
      }

      const hashKey = this.#generateUrlSourceHash(url, source);
      if (!groupedSuggestions.has(hashKey)) {
        groupedSuggestions.set(hashKey, {
          url,
          source,
          suggestions: [],
        });
      }
      groupedSuggestions.get(hashKey).suggestions.push(suggestion);
    }

    return groupedSuggestions;
  }

  /**
   * Reads and parses JSON content from S3.
   * @param {object} s3Client - S3 client instance.
   * @param {string} bucket - S3 bucket name.
   * @param {string} key - S3 object key.
   * @returns {Promise<object|null>} Parsed JSON content or null if error.
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  async #readJsonFromS3(s3Client, bucket, key) {
    try {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3Client.send(command);
      const content = await response.Body.transformToString();
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Reads file content from S3.
   * @param {object} s3Client - S3 client instance.
   * @param {string} bucket - S3 bucket name.
   * @param {string} key - S3 object key.
   * @returns {Promise<string|null>} File content or null if error.
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  async #readFileFromS3(s3Client, bucket, key) {
    try {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3Client.send(command);
      return await response.Body.transformToString();
    } catch (error) {
      return null;
    }
  }

  /**
   * Lists objects in S3 with a given prefix.
   * @param {object} s3Client - S3 client instance.
   * @param {string} bucket - S3 bucket name.
   * @param {string} prefix - S3 prefix to list objects.
   * @returns {Promise<Array>} Array of object keys.
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  async #listS3Objects(s3Client, bucket, prefix) {
    try {
      const command = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix });
      const response = await s3Client.send(command);
      return response.Contents ? response.Contents.map((obj) => obj.Key) : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Gets service access token from IMS client using client credentials
   * @param {Object} imsClient - The IMS client from context
   * @param {Object} env - Environment variables
   * @param {Object} log - Logger instance
   * @returns {Promise<string|null>} Service access token or null if failed
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  async #getServiceAccessToken(imsClient, env, log) {
    try {
      // Use existing IMS configuration pattern similar to other controllers
      const {
        IMS_HOST: host,
        IMS_CLIENT_ID: clientId,
        IMS_CLIENT_SECRET: clientSecret,
      } = env;

      if (!hasText(host) || !hasText(clientId) || !hasText(clientSecret)) {
        log.error('IMS client credentials not found in environment');
        return null;
      }

      // Generate service token using client credentials
      const serviceToken = await imsClient.getServiceAccessToken();
      return serviceToken;
    } catch (error) {
      log.error(`Error obtaining IMS service token: ${error.message}`);
      return null;
    }
  }
}
