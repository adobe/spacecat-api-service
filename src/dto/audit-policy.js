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

const DEFAULTS = { budget: 5000, strategyName: 'tiered' };

export const AuditPolicyDto = {
  toJSON(row) {
    return {
      siteId: row.site_id,
      version: row.version,
      budget: row.budget,
      strategyName: row.strategy_name,
      exclusionGlobs: row.exclusion_globs,
      manualUrls: row.manual_urls,
      scopeConfig: row.scope_config,
      lifecycleOverrides: row.lifecycle_overrides,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      reason: row.reason,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
  defaultDocument(siteId) {
    return {
      siteId,
      version: 0,
      budget: DEFAULTS.budget,
      strategyName: DEFAULTS.strategyName,
      exclusionGlobs: [],
      manualUrls: [],
      scopeConfig: {},
      lifecycleOverrides: {},
      createdBy: null,
      updatedBy: null,
      reason: null,
      note: null,
      createdAt: null,
      updatedAt: null,
    };
  },
};

export const AuditPolicyRevisionDto = {
  toJSON(row) {
    return {
      version: row.version,
      budget: row.budget,
      strategyName: row.strategy_name,
      exclusionGlobs: row.exclusion_globs,
      manualUrls: row.manual_urls,
      scopeConfig: row.scope_config,
      lifecycleOverrides: row.lifecycle_overrides,
      updatedBy: row.updated_by,
      reason: row.reason,
      note: row.note,
      effectiveAt: row.effective_at,
      supersededAt: row.superseded_at,
    };
  },
};
