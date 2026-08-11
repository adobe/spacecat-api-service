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

// Postgres returns timestamptz columns as raw text (microsecond precision, numeric offset,
// e.g. "2026-01-01T00:00:00.123456+00:00") - normalize to the Z-suffixed, millisecond-precision
// ISO8601 every other resource in this API returns (via the shared ORM's Date.toISOString()).
// Deliberately throws (RangeError) rather than passing an unparseable value through: a real
// timestamptz column is never non-date text, so a throw here means the row itself is
// corrupted - surface that loudly instead of silently returning garbage to a client.
const toISO = (value) => (value == null ? value : new Date(value).toISOString());

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
      createdAt: toISO(row.created_at),
      updatedAt: toISO(row.updated_at),
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
  // `resolvedUpdatedBy` is a human-readable display name/email resolved server-side (e.g. via
  // IMS) for the row's raw `updated_by` value; falls back to the raw value when it can't be
  // resolved (already a plain email/name, or IMS lookup failed/unavailable). The `typeof`
  // guard below defends against `list.map(AuditPolicyRevisionDto.toJSON)` - the repo's dominant
  // DTO idiom - which would otherwise pass the array index in as `resolvedUpdatedBy`.
  toJSON(row, resolvedUpdatedBy) {
    return {
      version: row.version,
      budget: row.budget,
      strategyName: row.strategy_name,
      exclusionGlobs: row.exclusion_globs,
      manualUrls: row.manual_urls,
      scopeConfig: row.scope_config,
      lifecycleOverrides: row.lifecycle_overrides,
      updatedBy: (typeof resolvedUpdatedBy === 'string' ? resolvedUpdatedBy : null) || row.updated_by,
      reason: row.reason,
      note: row.note,
      effectiveAt: toISO(row.effective_at),
      supersededAt: toISO(row.superseded_at),
    };
  },
};

export const AuditScopePageDto = {
  toJSON(row) {
    return {
      url: row.url,
      urlPath: row.url_path,
      discoverySource: row.discovery_source,
      lastModified: toISO(row.last_modified),
      lifecycleState: row.lifecycle_state,
    };
  },
};

export const AuditScopeSummaryDto = {
  toJSON(row) {
    return {
      inList: row.in_list,
      audited: row.audited,
      excluded: row.excluded,
      lifecycleSuppressed: row.lifecycle_suppressed,
      keptStaleDetection: row.kept_stale_detection,
      notYetScanned: row.not_yet_scanned,
      budget: row.budget,
      strategyName: row.strategy_name,
    };
  },
  defaultDocument() {
    return {
      inList: 0,
      audited: 0,
      excluded: 0,
      lifecycleSuppressed: 0,
      keptStaleDetection: 0,
      notYetScanned: 0,
      budget: DEFAULTS.budget,
      strategyName: DEFAULTS.strategyName,
    };
  },
};
