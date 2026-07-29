/*
 * Copyright 2024 Adobe. All rights reserved.
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
 * Data transfer object for Configuration.
 */
export const ConfigurationDto = {
  /**
   * Converts a Configuration object into a JSON object.
   * @param {Readonly<Configuration>} configuration - Configuration object.
   * @returns {{
   * }}
   */
  toJSON: (configuration) => ({
    version: configuration.getVersion(),
    jobs: configuration.getJobs(),
    ...(configuration.getHandlers() ? { handlers: configuration.getHandlers() } : {}),
    queues: configuration.getQueues(),
    ...(configuration.getSlackRoles() ? { slackRoles: configuration.getSlackRoles() } : {}),
  }),

  /**
   * Converts a page of configuration versions (from
   * `ConfigurationCollection.listVersions`) into the API response shape.
   * @param {{versions: object[], isTruncated: boolean,
   *   nextKeyMarker: (string|null), nextVersionIdMarker: (string|null)}} page
   * @returns {object} The version-list response.
   */
  versionsToJSON: (page) => ({
    versions: (page.versions || []).map((version) => ({
      versionId: version.versionId,
      lastModified: version.lastModified,
      isLatest: version.isLatest,
      size: version.size,
      ...(version.updatedBy !== undefined ? { updatedBy: version.updatedBy } : {}),
      ...(version.updatedAt !== undefined ? { updatedAt: version.updatedAt } : {}),
    })),
    isTruncated: Boolean(page.isTruncated),
    nextKeyMarker: page.nextKeyMarker ?? null,
    nextVersionIdMarker: page.nextVersionIdMarker ?? null,
  }),
};
