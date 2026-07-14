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
 * CloudWatch EMF metric emitters for the dynamic (JIT) Semrush AI resource allocator
 * (LLMO-6191, rollout-hardening item 2 — "observability and SLIs").
 *
 * This module is a thin, allocator-specific wrapper over the existing generic EMF emitter
 * (`../metrics-emf.js`) — it does NOT invent a new metrics pipeline. Every function here is
 * best-effort (the underlying `emitMetric` already swallows its own errors) and MUST NEVER throw
 * or otherwise affect the allocator's control flow; a metrics bug must never become a
 * customer-facing failure.
 *
 * Deliberately LOW-CARDINALITY dimensions: metrics are dimensioned by `Environment`, `Dim`
 * (projects|prompts), and a small closed `Reason`/`Outcome` vocabulary — NEVER by raw
 * workspace/brand ids (unbounded cardinality, and CloudWatch bills per unique dimension-value
 * combination). Anything that needs the actual workspace id for triage stays in the existing
 * `SERENITY_ALLOC` structured log lines (see resource-manager.js) — this mirrors the existing
 * split between generic client-facing error messages and detailed server-side logs (see
 * resource-manager.js's typed-errors section).
 *
 * Metric catalog (CloudWatch namespace `Mysticat/SerenityAllocation`):
 * - `HeadroomCheck` (Count, dims: Outcome=hot-path|topped-up) — the hot-path ratio
 *   (serenity-docs#22 plan §21): a rising topped-up share is the leading indicator of pool drain.
 * - `TopUpLatencyMs` (Milliseconds) — wall-clock time of a single top-up transfer attempt.
 * - `PoolFreeRatio` (Percent, dims: Dim) — the master/parent workspace's advisory `free/total`
 *   ratio, read at the same point `ensureAiHeadroom` already does its (non-gating) pool check.
 * - `AllocationRejection` (Count, dims: Reason=orgPoolExhausted|brandAiLimit|workspaceBusy) —
 *   every typed rejection the allocator throws.
 * - `NotReadyRetry` (Count) — one per `workspace not ready` retry attempt in `transferAndSettle`.
 * - `ReleaseOutcome` (Count, dims: Reason=released|nothing-to-release|requires-decommission|error)
 *   — `releaseAiSurplus` outcomes; `requires-decommission` is a standing pool-leak signal (surplus
 *   that cannot be reclaimed short of workspace delete).
 * - `MeteredQuotaClassifier` (Count, dims: Matched=true|false) — how often the disguised-405
 *   quota classifier (`isMeteredQuota`, errors.js) fires. NOTE: as of this PR `isMeteredQuota` has
 *   no production call site yet (see errors.js doc comment) — this metric exists so a future
 *   caller gets observability for free, but will read zero until one is wired up.
 *
 * Pager-worthy vs dashboard-only (per the original design doc, restated here for the alarm
 * author): `AllocationRejection{Reason=orgPoolExhausted|brandAiLimit}` is EXPECTED under normal
 * load on a small pool — dashboard-only, NOT pager-worthy. `AllocationRejection{Reason=
 * workspaceBusy}` (a transfer that never cleared the async lock) and a `NotReadyRetry` run that
 * exhausts its retries are signals that JIT top-up itself is degraded — these ARE pager-worthy.
 * See docs/runbooks/serenity-zombie-workspace-recovery.md for the alarm/paging guidance and the
 * caveat that this repo has no alerting-as-code file to wire the actual alarm into (a manual
 * Coralogix/CloudWatch alarm is still required — see the runbook).
 */

import { emitMetric, resolveEnvironment } from '../metrics-emf.js';

const NAMESPACE = 'Mysticat/SerenityAllocation';

/**
 * Reads the environment straight off `process.env` rather than requiring every caller (several
 * layers deep inside the allocator's read/transfer helpers, none of which are otherwise env-aware)
 * to thread `context.env` through. `AWS_ENV` is a real Lambda process environment variable (set
 * at deploy time, not a per-request secret), so `process.env.AWS_ENV` and `context.env.AWS_ENV`
 * read the same value in every deployed environment; the standalone rightsizing-sweep script sets
 * the same var directly on `process.env` for the same reason.
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
 * Hot-path ratio: one call per `ensureAiHeadroom` invocation.
 * @param {boolean} toppedUp
 * @returns {void}
 */
export function recordHeadroomCheck(toppedUp) {
  emit({ name: 'HeadroomCheck', dimensions: { Outcome: toppedUp ? 'topped-up' : 'hot-path' } });
}

/**
 * @param {number} ms wall-clock duration of one transfer attempt.
 * @returns {void}
 */
export function recordTopUpLatency(ms) {
  emit({ name: 'TopUpLatencyMs', value: ms, unit: 'Milliseconds' });
}

/**
 * Advisory master-pool free ratio at the point `ensureAiHeadroom` already reads it. `free`/`total`
 * may legitimately be 0/0 (an unset pool) — guarded here.
 * @param {'projects'|'prompts'} dim
 * @param {number} free
 * @param {number} total
 * @returns {void}
 */
export function recordPoolFreeRatio(dim, free, total) {
  if (!(total > 0)) {
    return; // avoid emitting a divide-by-zero / meaningless ratio for an unset pool
  }
  emit({
    name: 'PoolFreeRatio', value: (free / total) * 100, unit: 'Percent', dimensions: { Dim: dim },
  });
}

/**
 * @param {'orgPoolExhausted'|'brandAiLimit'|'workspaceBusy'} reason
 * @returns {void}
 */
export function recordRejection(reason) {
  emit({ name: 'AllocationRejection', dimensions: { Reason: reason } });
}

/** @returns {void} */
export function recordNotReadyRetry() {
  emit({ name: 'NotReadyRetry' });
}

/**
 * @param {'released'|'nothing-to-release'|'requires-decommission'|'error'} reason
 * @returns {void}
 */
export function recordReleaseOutcome(reason) {
  emit({ name: 'ReleaseOutcome', dimensions: { Reason: reason } });
}

/**
 * @param {boolean} matched
 * @returns {void}
 */
export function recordMeteredQuotaClassifier(matched) {
  emit({ name: 'MeteredQuotaClassifier', dimensions: { Matched: matched } });
}
