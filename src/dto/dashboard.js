/*
 * Copyright 2026 Adobe. All rights reserved.
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
 * Data Transfer Object for the in-memory Dashboard record — never returns the raw store
 * object (e.g. drops nothing sensitive today, but keeps the same "never expose the model
 * directly" shape this repo's other DTOs follow, so swapping the store for a real
 * persisted entity later doesn't change the response shape).
 */
export const DashboardDto = {
  /**
   * @param {Object} dashboard - a record from in-memory-dashboard-store.js
   * @param {string} callerUserId - the requesting user, to compute `isStarred`
   */
  toJSON: (dashboard, callerUserId) => ({
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description,
    ownerId: dashboard.ownerId,
    visibility: dashboard.visibility,
    sharedWith: dashboard.sharedWith,
    controls: dashboard.controls,
    sections: dashboard.sections,
    tiles: dashboard.tiles,
    isStarred: dashboard.starredBy.includes(callerUserId),
    createdAt: dashboard.createdAt,
    updatedAt: dashboard.updatedAt,
    schemaVersion: dashboard.schemaVersion,
  }),
};
