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

// @ts-check

/**
 * CloudWatch EMF metric emitters for the disguised metered-quota classifier and quota rejection
 * (namespace `Mysticat/SerenityAllocation`).
 *
 * SCOPE (SITES-49206): the dynamic (JIT) Semrush AI allocator was removed once Semrush stopped
 * enforcing AI project/prompt limits for proxy-routed LLMO workspaces (confirmed 2026-07-28), and
 * with it all of the allocator-only emitters this module used to carry (`HeadroomCheck`,
 * `TopUpLatencyMs`, `PoolFreeRatio`, `NotReadyRetry`, `ReleaseOutcome`, `QuotaRetryOutcome`). Only
 * the two emitters below survive, because they back the §10.6 quota-exhaustion handling that is
 * deliberately deleted LAST (after the metered-405 canary — see errors.js `isMeteredQuota` /
 * `toQuotaExceededError`), NOT part of this allocator removal.
 *
 * This module is a thin wrapper over the generic EMF emitter (`../metrics-emf.js`) — it does NOT
 * invent a new metrics pipeline. Every function here is best-effort (the underlying `emitMetric`
 * already swallows its own errors) and MUST NEVER throw or otherwise affect control flow; a metrics
 * bug must never become a customer-facing failure. Deliberately LOW-CARDINALITY dimensions: never
 * raw workspace/brand ids (unbounded cardinality; CloudWatch bills per unique dimension-value
 * combination).
 *
 * Metric catalog (CloudWatch namespace `Mysticat/SerenityAllocation`):
 * - `AllocationRejection` (Count, dims: Reason=quotaExceeded) — the classified metered-quota
 *   rejection surfaced by `toQuotaExceededError` (errors.js).
 * - `MeteredQuotaClassifier` (Count, dims: Matched=true|false) — how often the disguised-405
 *   quota classifier (`isMeteredQuota`, errors.js) fires.
 */

import { emitMetric, resolveEnvironment } from '../metrics-emf.js';

const NAMESPACE = 'Mysticat/SerenityAllocation';

/**
 * Reads the environment straight off `process.env` rather than requiring every caller to thread
 * `context.env` through. `AWS_ENV` is a real Lambda process environment variable (set at deploy
 * time, not a per-request secret), so `process.env.AWS_ENV` and `context.env.AWS_ENV` read the same
 * value in every deployed environment.
 * @returns {string}
 */
function currentEnvironment() {
  return resolveEnvironment(process.env);
}

/**
 * @param {{ name: string, value?: number, unit?: string, dimensions?: object }} metric
 */
function emit(metric) {
  emitMetric(metric, { environment: currentEnvironment(), namespace: NAMESPACE });
}

/**
 * @param {'quotaExceeded'} reason
 * @returns {void}
 */
export function recordRejection(reason) {
  emit({ name: 'AllocationRejection', dimensions: { Reason: reason } });
}

/**
 * @param {boolean} matched
 * @returns {void}
 */
export function recordMeteredQuotaClassifier(matched) {
  emit({ name: 'MeteredQuotaClassifier', dimensions: { Matched: matched } });
}
