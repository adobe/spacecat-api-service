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
 * Canonical catalog of CloudWatch EMF metrics emitted by the ASO dispatcher
 * overlay read path (`GET /config/:service/redirects.txt`) and its auth handler.
 * Drift guard: `RedirectsController` and `AsoOverlayKeyHandler` must reference
 * exactly these names, and the Grafana dashboard queries against them via the
 * `Mysticat/AsoOverlay` CloudWatch namespace.
 *
 * Cardinality note: no per-tenant dimensions here. CloudWatch charges per unique
 * dimension combination; 10k+ CM services would blow the budget. Tenant-level
 * views come from Fastly access logs in Splunk instead.
 */

export const ASO_OVERLAY_NAMESPACE = 'Mysticat/AsoOverlay';

export const ASO_OVERLAY_METRICS = Object.freeze([
  'AsoOverlayRequestTotal', // Count · dims: Environment, Outcome, Tier
  'AsoOverlayRequestDurationMs', // Milliseconds · dims: Environment, Outcome
  'AsoOverlayEtagPresent', // Count · dims: Environment (subset of 200)
  'AsoOverlayConditionalGet304', // Count · dims: Environment (INM matched)
  'AsoOverlayIfNoneMatchInvalid', // Count · dims: Environment, Reason
  'AsoOverlayS3ReadDurationMs', // Milliseconds · dims: Environment, Outcome
  'AsoOverlayAuthKeyUsed', // Count · dims: Environment, Slot (rotation-in-flight signal)
  'AsoOverlayAuthFailed', // Count · dims: Environment, Reason
]);

// Outcome enum for AsoOverlayRequestTotal / AsoOverlayRequestDurationMs /
// AsoOverlayS3ReadDurationMs. Distinguishes 404 sub-reasons so on-call can tell
// authz-fail from S3-object-missing (indistinguishable to clients by design).
export const OUTCOME = Object.freeze({
  OK_200: '200',
  NOT_MODIFIED_304: '304',
  BAD_REQUEST_400: '400',
  AUTHZ_NO_SITE: '404-authz-nosite',
  AUTHZ_NO_ENTITLEMENT: '404-authz-noent',
  AUTHZ_NOT_ENROLLED: '404-authz-noenroll',
  S3_NO_SUCH_KEY: '404-s3-nosuchkey',
  S3_ACCESS_DENIED: '404-s3-accessdenied',
  BUCKET_NOT_CONFIGURED: '500-config',
  S3_UNEXPECTED: '500-s3',
});

// Reason enum for AsoOverlayAuthFailed.
export const AUTH_FAIL_REASON = Object.freeze({
  MISSING: 'missing', // Header absent OR not path-scoped to overlay
  INVALID: 'invalid', // Header present but doesn't match either key slot
  MALFORMED: 'malformed', // ASO_OVERLAY_API_KEY env var not configured
});

// Reason enum for AsoOverlayIfNoneMatchInvalid. Whitespace-only values are
// normalized to null by `getHeader` and reach the controller as "absent" — so
// we don't track them separately.
export const INM_INVALID_REASON = Object.freeze({
  UNQUOTED: 'unquoted', // Client sent bare token without RFC 7232 §2.3 quotes
});

// Slot enum for AsoOverlayAuthKeyUsed. `previous` non-zero signals rotation
// in-flight; sustained non-zero across > 24h signals rotation didn't complete.
export const AUTH_KEY_SLOT = Object.freeze({
  CURRENT: 'current',
  PREVIOUS: 'previous',
});
