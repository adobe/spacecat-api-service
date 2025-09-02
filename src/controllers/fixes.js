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
/* eslint-disable no-use-before-define */

/**
 * @import {
 *   FixEntity,
 *   FixEntityCollection,
 *   OpportunityCollection,
 *   SiteCollection,
 *   SuggestionCollection
 * } from "@adobe/spacecat-shared-data-access"
 */

import {
  badRequest,
  createResponse,
  forbidden,
  noContent,
  notFound,
  ok,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import {
  hasText, isArray, isIsoDate, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { createHash } from 'crypto';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import AccessControlUtil from '../support/access-control-util.js';
import { FixDto } from '../dto/fix.js';
import { SuggestionDto } from '../dto/suggestion.js';

/**
 * @typedef {Object} DataAccess
 * @property {FixEntityCollection} FixEntity
 * @property {OpportunityCollection} Opportunity
 * @property {SuggestionCollection} Suggestion
 *
 * @typedef {Object} LambdaContext
 * @property {DataAccess} dataAccess
 *
 * @typedef {Object} RequestContext
 * @property {Object.<string, undefined | null | boolean | number | string>} [params]
 * @property {any} [data]
 */

export class FixesController {
  /** @type {FixEntityCollection} */
  #FixEntity;

  /** @type {OpportunityCollection} */
  #Opportunity;

  /** @type {SiteCollection} */
  #Site;

  /** @type {SuggestionCollection} */
  #Suggestion;

  /** @type {AccessControlUtil} */
  #accessControl;

  /**
   * @param {LambdaContext} ctx
   * @param {AccessControlUtil} [accessControl]
   */
  constructor(ctx, accessControl = new AccessControlUtil(ctx)) {
    const { dataAccess } = ctx;
    this.#FixEntity = dataAccess.FixEntity;
    this.#Opportunity = dataAccess.Opportunity;
    this.#Site = dataAccess.Site;
    this.#Suggestion = dataAccess.Suggestion;
    this.#accessControl = accessControl;
  }

  /**
   * Gets all suggestions for a given site and opportunity.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllForOpportunity(context) {
    const { siteId, opportunityId } = context.params;

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fixEntities = await this.#FixEntity.allByOpportunityId(opportunityId);

    // Check whether the suggestion belongs to the opportunity,
    // and the opportunity belongs to the site.
    res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    const fixes = fixEntities.map((fix) => FixDto.toJSON(fix));
    return ok(fixes);
  }

  /**
   * Gets all suggestions for a given site, opportunity and status.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getByStatus(context) {
    const { siteId, opportunityId, status } = context.params;
    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!hasText(status)) {
      return badRequest('Status is required');
    }

    const fixEntities = await this.#FixEntity.allByOpportunityIdAndStatus(opportunityId, status);
    res = await checkOwnership(fixEntities[0], opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    return ok(fixEntities.map((fix) => FixDto.toJSON(fix)));
  }

  /**
   * Get a suggestion given a site, opportunity and suggestion ID
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Suggestion response.
   */
  async getByID(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    return ok(FixDto.toJSON(fix));
  }

  /**
   * Gets all suggestions for a given fix.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of suggestions response.
   */
  async getAllSuggestionsForFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    const suggestions = await fix.getSuggestions();
    return ok(suggestions.map(SuggestionDto.toJSON));
  }

  /**
   * Creates one or more fixes for a given site and opportunity.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} Array of fixes response.
   */
  async createFixes(context) {
    const { siteId, opportunityId } = context.params;

    let res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    res = await checkOwnership(null, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return context.data ? badRequest('Request body must be an array') : badRequest('No updates provided');
    }

    const FixEntity = this.#FixEntity;
    const fixes = await Promise.all(context.data.map(async (fixData, index) => {
      try {
        return {
          index,
          fix: FixDto.toJSON(await FixEntity.create({ ...fixData, opportunityId })),
          statusCode: 201,
        };
      } catch (error) {
        return {
          index,
          message: error.message,
          statusCode: error instanceof ValidationError ? /* c8 ignore next */ 400 : 500,
        };
      }
    }));
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: {
        total: fixes.length,
        success: succeeded,
        failed: fixes.length - succeeded,
      },
    }, 207);
  }

  /**
   * Update the status of one or multiple fixes in one transaction
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated opportunity data
   */
  async patchFixesStatus(context) {
    const { siteId, opportunityId } = context.params;

    const res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!Array.isArray(context.data)) {
      return (
        context.data
          ? badRequest('Request body must be an array of [{ id: <fix id>, status: <fix status> },...]')
          : badRequest('No updates provided')
      );
    }

    const fixes = await Promise.all(
      context.data.map(
        (data, index) => this.#patchFixStatus(data.id, data.status, index, opportunityId, siteId),
      ),
    );
    const succeeded = countSucceeded(fixes);
    return createResponse({
      fixes,
      metadata: { total: fixes.length, success: succeeded, failed: fixes.length - succeeded },
    }, 207);
  }

  async #patchFixStatus(uuid, status, index, opportunityId, siteId) {
    if (!hasText(uuid)) {
      return {
        index,
        uuid: '',
        message: 'fix id is required',
        statusCode: 400,
      };
    }
    if (!hasText(status)) {
      return {
        index,
        uuid,
        message: 'fix status is required',
        statusCode: 400,
      };
    }

    const fix = await this.#FixEntity.findById(uuid);
    const res = fix
      ? await checkOwnership(fix, opportunityId, siteId, this.#Opportunity)
      : notFound('Fix not found');
    if (res) {
      return {
        index,
        uuid,
        message: await res.json().then(({ message }) => message),
        statusCode: res.status,
      };
    }

    try {
      if (fix.getStatus() === status) {
        return {
          index, uuid, message: 'No updates provided', statusCode: 400,
        };
      }

      fix.setStatus(status);
      return {
        index, uuid, fix: FixDto.toJSON(await fix.save()), statusCode: 200,
      };
    } catch (error) {
      const statusCode = error instanceof ValidationError ? /* c8 ignore next */ 400 : 500;
      return {
        index, uuid, message: error.message, statusCode,
      };
    }
  }

  /**
   * Updates data for a fix.
   *
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>} the updated fix data
   */
  async patchFix(context) {
    const { siteId, opportunityId, fixId } = context.params;
    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    if (!context.data) {
      return badRequest('No updates provided');
    }

    const {
      executedBy, executedAt, publishedAt, changeDetails, suggestionIds,
    } = context.data;

    const Suggestion = this.#Suggestion;
    let hasUpdates = false;
    try {
      if (isArray(suggestionIds)) {
        const suggestions = await Promise.all(suggestionIds.map((id) => Suggestion.findById(id)));
        if (suggestions.some((s) => !s || s.getOpportunityId() !== opportunityId)) {
          return badRequest('Invalid suggestion IDs');
        }
        for (const suggestion of suggestions) {
          suggestion.setFixEntityId(fixId);
        }
        await Promise.all(suggestions.map((s) => s.save()));
        hasUpdates = true;
      }

      if (executedBy !== fix.getExecutedBy() && hasText(executedBy)) {
        fix.setExecutedBy(executedBy);
        hasUpdates = true;
      }

      if (executedAt !== fix.getExecutedAt() && isIsoDate(executedAt)) {
        fix.setExecutedAt(executedAt);
        hasUpdates = true;
      }

      if (publishedAt !== fix.getPublishedAt() && isIsoDate(publishedAt)) {
        fix.setPublishedAt(publishedAt);
        hasUpdates = true;
      }

      if (isNonEmptyObject(changeDetails)) {
        fix.setChangeDetails(changeDetails);
        hasUpdates = true;
      }

      if (hasUpdates) {
        return ok(FixDto.toJSON(await fix.save()));
      } else {
        return badRequest('No updates provided');
      }
    } catch (e) {
      return e instanceof ValidationError
        ? /* c8 ignore next */ badRequest(e.message)
        : createResponse({ message: 'Error updating fix' }, 500);
    }
  }

  /**
   * Removes a fix
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>}
   */
  async removeFix(context) {
    const { siteId, opportunityId, fixId } = context.params;

    let res = checkRequestParams(siteId, opportunityId, fixId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    const fix = await this.#FixEntity.findById(fixId);
    if (!fix) return notFound('Fix not found');
    res = await checkOwnership(fix, opportunityId, siteId, this.#Opportunity);
    if (res) return res;

    try {
      await fix.remove();
      return noContent();
    } catch (e) {
      return createResponse({ message: `Error removing fix: ${e.message}` }, 500);
    }
  }

  /**
   * Applies accessibility fixes by calling AIO app to create PR
   * @param {RequestContext} context - request context
   * @returns {Promise<Response>}
   */
  async applyAccessibilityFix(context) {
    const { siteId, opportunityId } = context.params;
    const {
      log, env, imsClient, s3,
    } = context;
    const asoPrHandlerUrl = '/api/v1/web/aem-sites-optimizer-gh-app/pull-request-handler';

    const res = checkRequestParams(siteId, opportunityId) ?? await this.#checkAccess(siteId);
    if (res) return res;

    if (!context.data) {
      return badRequest('Request body is required');
    }

    const { suggestionIds } = context.data;

    if (!isArray(suggestionIds) || suggestionIds.length === 0) {
      return badRequest('suggestionIds array is required and must not be empty');
    }

    // Validate all suggestion IDs are valid UUIDs
    for (const id of suggestionIds) {
      if (!isValidUUID(id)) {
        return badRequest(`Invalid suggestion ID format: ${id}`);
      }
    }

    // Get the opportunity and verify it belongs to the site
    const opportunity = await this.#Opportunity.findById(opportunityId);
    if (!opportunity || opportunity.getSiteId() !== siteId) {
      return notFound('Opportunity not found');
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
      // Get site details to access the IMS org ID and repo URL
      const site = await this.#Site.findById(siteId);

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
      const groupedSuggestions = FixesController.#groupSuggestionsByUrlSource(suggestions);

      if (groupedSuggestions.size === 0) {
        return badRequest('No valid suggestions with URL and source found');
      }

      const results = [];
      const { s3Client } = s3;

      // Process each group
      for (const [hashKey, group] of groupedSuggestions) {
        const { url, source, suggestions: groupSuggestions } = group;

        log.info(`Processing group for URL: ${url}, Source: ${source}, Hash: ${hashKey}`);

        // Look for fixes in S3 bucket
        const s3Prefix = `fixes/${siteId}/${hashKey}/`;
        // eslint-disable-next-line no-await-in-loop
        const s3Objects = await FixesController.#listS3Objects(s3Client, mystiqueBucket, s3Prefix);

        if (s3Objects.length === 0) {
          log.warn(`No fixes found in S3 for hash key: ${hashKey}`);
          // eslint-disable-next-line no-continue
          continue;
        }

        // Find report.json files in subfolders
        const reportFiles = s3Objects.filter((key) => key.endsWith('/report.json'));

        for (const reportPath of reportFiles) {
          // eslint-disable-next-line no-await-in-loop
          const report = await FixesController.#readJsonFromS3(
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
              const content = await FixesController.#readFileFromS3(
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
          const description = matchingIssue?.description || `Fix ${report.type} accessibility issue`;

          // Prepare payload for AIO app
          const aioPayload = {
            title: description,
            vcsType: 'github',
            updatedFiles,
            repoURL: repoUrl,
          };

          // Get service access token from IMS client
          // eslint-disable-next-line no-await-in-loop
          const serviceToken = await FixesController.#getServiceAccessToken(imsClient, env, log);
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
              url,
              source,
              error: `AIO app returned ${aioResponse.status}: ${aioResponse.statusText}`,
            });
            // eslint-disable-next-line no-continue
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const aioResult = await aioResponse.json();
          log.info(`Successfully applied accessibility fix for type: ${report.type}, URL: ${url}, Source: ${source}`);

          results.push({
            success: true,
            type: report.type,
            url,
            source,
            prUrl: aioResult.pullRequest,
            updatedFiles: updatedFiles.map((f) => f.path),
            appliedSuggestions: matchingSuggestions.map((s) => s.getId()),
          });

          // Break after first successful match per group
          break;
        }
      }

      if (results.length === 0) {
        return badRequest('No matching fixes found in S3 for the provided suggestions');
      }

      const successfulResults = results.filter((r) => r.success);
      const failedResults = results.filter((r) => !r.success);

      return ok({
        message: `Applied ${successfulResults.length} accessibility fix(es) successfully`,
        successful: successfulResults,
        failed: failedResults,
        totalProcessed: results.length,
      });
    } catch (error) {
      log.error(`Error applying accessibility fix ${error.message}`);
      return internalServerError('Failed to apply accessibility fix');
    }
  }

  /**
   * Generates a hash key from URL and source combination.
   * @param {string} url - The URL.
   * @param {string} source - The source.
   * @returns {string} MD5 hash of the combined URL and source (first 16 characters).
   */
  static #generateUrlSourceHash(url, source) {
    const combined = `${url}_${source}`;
    return createHash('md5').update(combined).digest('hex').substring(0, 16);
  }

  /**
   * Groups suggestions by URL and source.
   * @param {Array} suggestions - Array of suggestion objects.
   * @returns {Map} Map with hash keys and grouped suggestions.
   */
  static #groupSuggestionsByUrlSource(suggestions) {
    const groupedSuggestions = new Map();

    for (const suggestion of suggestions) {
      const { url, source } = suggestion.getData();
      if (!url || !source) {
        // eslint-disable-next-line no-continue
        continue;
      }

      const hashKey = FixesController.#generateUrlSourceHash(url, source);
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
   */
  static async #readJsonFromS3(s3Client, bucket, key) {
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
   */
  static async #readFileFromS3(s3Client, bucket, key) {
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
   */
  static async #listS3Objects(s3Client, bucket, prefix) {
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
  static async #getServiceAccessToken(imsClient, env, log) {
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
      log.error(`Error obtaining IMS service token: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Checks if the user has admin access.
   * @param {string} siteId
   * @returns {Response | null} forbidden response or null.
   */
  async #checkAccess(siteId) {
    const site = await this.#Site.findById(siteId);
    /* c8 ignore start */
    if (!site) {
      return notFound('Site not found');
    }
    /* c8 ignore end */

    return await this.#accessControl.hasAccess(site)
      ? null
      : forbidden('Only users belonging to the organization may access fix entities.');
  }
}

/**
 * Checks whether siteId and opportunityId are valid UUIDs.
 * Supports optional fixId.
 * @param {any} siteId
 * @param {any} opportunityId
 * @param {any} [fixId]
 * @returns {Response | null} badRequest response or null
 */
function checkRequestParams(siteId, opportunityId, fixId = UNSET) {
  if (!isValidUUID(siteId)) {
    return badRequest('Site ID required');
  }

  if (!isValidUUID(opportunityId)) {
    return badRequest('Opportunity ID required');
  }

  if (fixId !== UNSET && !isValidUUID(fixId)) {
    return badRequest('Fix ID required');
  }

  return null;
}
const UNSET = Symbol('UNSET');

/**
 * Checks if the fix belongs to the opportunity and the opportunity belongs to the site.
 *
 * @param {undefined | null | FixEntity} fix
 * @param {string} opportunityId
 * @param {string} siteId
 * @param {OpportunityCollection} opportunities
 * @returns {Promise<null | Response>}
 */
async function checkOwnership(fix, opportunityId, siteId, opportunities) {
  if (fix && fix.getOpportunityId() !== opportunityId) {
    return notFound('Opportunity not found');
  }
  const opportunity = await (fix ? fix.getOpportunity() : opportunities.findById(opportunityId));
  if (!opportunity || opportunity.getSiteId() !== siteId) {
    return notFound('Opportunity not found');
  }
  return null;
}

/**
 * @param {Array<{statusCode: number}>} items
 * @returns {number} number of succeeded items
 */
function countSucceeded(items) {
  return items.reduce((succ, item) => succ + (item.statusCode < 400), 0);
}
