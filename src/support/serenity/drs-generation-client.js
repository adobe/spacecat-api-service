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

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { retryableJobError } from './async-job-runner.js';
import { emitMetric, resolveEnvironment } from '../metrics-emf.js';

/**
 * Client for the stateless SYNCHRONOUS DRS prompt-generation service
 * (adobe-rnd/llmo-data-retrieval-service#3165). api-service has no
 * prompt-generation LLM and no language detector, so DRS owns generation, the
 * language gate, and the quality/guardrail filtering, and returns a validated
 * batch. This module is the api-service side of that boundary: it bundles the
 * server-resolved seeds and invokes the DRS Lambda with `RequestResponse`
 * (bounded, synchronous — NOT an enqueue-and-await of a DRS job).
 *
 * SECURITY INVARIANT: **no promise token and no raw IMS token ever crosses this
 * boundary.** DRS receives only catalogue seeds + brand/market facts; the
 * write-scoped Semrush access token is exchanged AFTER this call returns, in the
 * worker, immediately before the Semrush writes.
 */

/**
 * Env/config key carrying the DRS generation Lambda's function name or ARN. Made a
 * config value (env/context) because the actual cross-account `lambda:InvokeFunction`
 * wiring lands in spacecat-infrastructure#780 — this repo must not hard-code an ARN.
 */
export const DRS_GENERATION_TARGET_ENV = 'DRS_PROMPT_GENERATION_FUNCTION';

/**
 * CloudWatch namespace the worker's DRS-invoke metrics land in — the alarms in
 * spacecat-infrastructure#780 read `DRSInvokeFailure` (Count) and
 * `DRSInvokeDurationMs` (Milliseconds) here. DRS emits no stuck/DLQ signal by
 * design, so these observability points must live on the api-service worker.
 */
export const METRICS_NAMESPACE = 'SpacecatSerenityMarketWorker';

/**
 * Client-side budget for a single DRS invoke, sized to fit UNDER the worker Lambda
 * timeout with headroom for the Semrush write/publish phase — the timeout nesting
 * spacecat-infrastructure#780 asserts is `worker 900s > (DRS 300s + writes 120s)`.
 * Enforced via an abort signal so a hung DRS invoke can't consume the whole run.
 */
export const DRS_INVOKE_TIMEOUT_MS = 300 * 1000;

/**
 * @typedef {object} DrsGenerationRequest
 * @property {Array<{ topic: string, volume?: number, examplePrompts?: string[] }>} seeds
 *   bounded/deduped catalogue seeds (topic + volume + example prompts).
 * @property {string} brand - brand display name.
 * @property {string[]} [aliases] - brand aliases.
 * @property {string} baseUrl - brand base URL.
 * @property {string} [subpath] - market subpath, if any.
 * @property {string} market - market country code.
 * @property {string} languageCode - the AUTHORITATIVE language code (api-service resolves it).
 * @property {string} [audience] - audience descriptor.
 * @property {number} count - desired prompt count.
 * @property {string} siteId - SpaceCat site id.
 * @property {string} imsOrgId - IMS org id.
 */

/**
 * @typedef {object} DrsGenerationResult
 * @property {Array<{ prompt: string, category?: string }>} prompts - validated prompts.
 * @property {Array<object>} [languageEvidence] - transient per-prompt evidence,
 *   aligned with `prompts` (index i ↔ prompts[i]); NOT persisted.
 * @property {{ verdict: 'ship'|'held'|'gate_error',
 *   error_category?: 'retryable'|'terminal' }} shipSummary
 */

/**
 * A terminal DRS outcome — a `held` / `gate_error` verdict, or a `terminal`
 * `error_category`. The job must FAIL (never retry, never publish an empty
 * market). Distinct from a {@link retryableJobError}.
 */
export class DrsGenerationTerminalError extends Error {
  /**
   * @param {string} message
   * @param {object} [details] - `{ code, verdict, errorCategory }`. `code` is the
   *   public error code the polling DTO surfaces so the UI can distinguish the
   *   terminal outcomes (held vs a hard failure); defaults to the generic
   *   `DRS_GENERATION_TERMINAL`.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'DrsGenerationTerminalError';
    /** @type {any} */ (this).code = details.code ?? 'DRS_GENERATION_TERMINAL';
    /** @type {any} */ (this).details = details;
  }
}

/**
 * Public error codes for the terminal generation outcomes, so the polling DTO's
 * `error.code` lets the UI (project-elmo-ui#3071) render distinct states:
 *   - `PROMPT_GENERATION_HELD`     — DRS `held` verdict (a soft quality hold) → UI "held".
 *   - `PROMPT_GENERATION_GATE_ERROR` — DRS terminal `gate_error` → UI "failed".
 *   - `PROMPT_GENERATION_EMPTY`    — DRS shipped zero prompts → UI "failed".
 *   - `DRS_GENERATION_TERMINAL`    — a config/contract failure (target unset) → UI "failed".
 * (`NEEDS_REAUTH` is separate — the runner sets it, and the DTO flags `needsReauth: true`.)
 */
export const GENERATION_ERROR_CODE = Object.freeze({
  HELD: 'PROMPT_GENERATION_HELD',
  GATE_ERROR: 'PROMPT_GENERATION_GATE_ERROR',
  EMPTY: 'PROMPT_GENERATION_EMPTY',
  TERMINAL: 'DRS_GENERATION_TERMINAL',
});

/**
 * Default AWS-SDK-backed invoker: constructs a `LambdaClient` for the worker's
 * region and issues a synchronous (`RequestResponse`) invoke. Region comes from
 * `context.runtime.region` (populated by helix-universal), matching the
 * `s3ClientWrapper` / `sqsWrapper` convention.
 *
 * @param {object} context
 * @returns {(functionName: string, payload: object) => Promise<object>} parsed JSON body.
 */
export function createLambdaInvoker(context) {
  const region = context?.runtime?.region;
  const client = new LambdaClient({ region });
  return async (functionName, payload) => {
    // Bound the invoke with an abort signal so a hung DRS call can't consume the
    // whole worker budget (DRS_INVOKE_TIMEOUT_MS). AbortSignal.timeout is Node 18+.
    const abortSignal = AbortSignal.timeout(DRS_INVOKE_TIMEOUT_MS);
    let response;
    try {
      response = await client.send(new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
      }), { abortSignal });
    } catch (error) {
      // A timeout/abort or transport error is transient — retry within the bound.
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw retryableJobError(`DRS generation invoke timed out after ${DRS_INVOKE_TIMEOUT_MS}ms`);
      }
      throw error;
    }

    // A Lambda-level failure (unhandled exception, init failure) or a non-200
    // status is transport-shaped: transient by default, so retry within the
    // job-level attempt bound rather than failing terminally.
    if (response.FunctionError || (response.StatusCode && response.StatusCode >= 300)) {
      const body = response.Payload ? Buffer.from(response.Payload).toString('utf8') : '';
      throw retryableJobError(
        `DRS generation invoke failed (FunctionError=${response.FunctionError ?? 'none'}, `
        + `status=${response.StatusCode}): ${body.slice(0, 500)}`,
      );
    }

    const raw = response.Payload ? Buffer.from(response.Payload).toString('utf8') : '';
    if (!raw) {
      throw retryableJobError('DRS generation invoke returned an empty payload');
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      // A non-JSON body is a contract violation, not a transient blip — terminal.
      throw new DrsGenerationTerminalError(`DRS generation returned non-JSON payload: ${e.message}`);
    }
  };
}

/**
 * Normalises the many shapes an AWS Lambda proxy/direct response can take into the
 * DRS body. A direct invoke returns the handler's return value verbatim; an
 * API-Gateway-proxy-shaped Lambda wraps it under `{ statusCode, body }` where
 * `body` is a JSON string. Tolerate both.
 * @param {any} parsed
 * @returns {any}
 */
function unwrapDrsBody(parsed) {
  if (parsed && typeof parsed === 'object' && typeof parsed.statusCode === 'number') {
    const { body } = parsed;
    if (parsed.statusCode >= 300) {
      throw retryableJobError(`DRS generation returned status ${parsed.statusCode}`);
    }
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new DrsGenerationTerminalError(`DRS generation body not JSON: ${e.message}`);
      }
    }
    return body ?? {};
  }
  return parsed;
}

/**
 * Invokes DRS generation and returns the validated batch, or throws a typed
 * retryable/terminal error derived from `ship_summary`.
 *
 * @param {object} context - worker context (`env`, `runtime`, `log`).
 * @param {DrsGenerationRequest} request - the server-resolved generation request
 *   (NO token — see the security invariant above).
 * @param {object} [opts]
 * @param {(functionName: string, payload: object) => Promise<object>} [opts.invoke]
 *   - injectable invoker (defaults to {@link createLambdaInvoker}); the seam unit
 *   tests drive without a live Lambda.
 * @returns {Promise<DrsGenerationResult>}
 * @throws {Error} `retryableJobError` on a retryable outcome;
 *   {@link DrsGenerationTerminalError} on terminal.
 */
export async function invokeDrsGeneration(context, request, { invoke } = {}) {
  const { env, log } = context;
  const functionName = env?.[DRS_GENERATION_TARGET_ENV];
  if (!functionName) {
    // A missing target is an environment-readiness defect (infra#780) — terminal,
    // never retry a permanent misconfiguration forever.
    throw new DrsGenerationTerminalError(
      `DRS generation target not configured (${DRS_GENERATION_TARGET_ENV} unset)`,
    );
  }

  // Best-effort EMF metrics (spacecat-infrastructure#780 alarms read these). Both
  // `DRSInvokeDurationMs` and `DRSInvokeFailure` carry ONLY the EMF `Environment`
  // dimension (lowercase dev|stage|prod); the infra alarms match on
  // `dimensions={Environment=<env>}` and read the plain metric — no Reason dimension.
  const metricsOpts = { environment: resolveEnvironment(env), namespace: METRICS_NAMESPACE };
  // `DRSInvokeFailure` is the PAGING metric — it must fire ONLY on a genuine
  // failure (a transport/invoke error, or a terminal `gate_error`), NEVER on
  // `ship` or `held`. `held` is fail-OPEN: a successful invoke whose substance
  // layer legitimately held the prompts — counting it here would page on-call for
  // every normal held market (spacecat-infrastructure#780 taxonomy). Both metrics
  // carry only the EMF `Environment` dimension; the failure reason lives in the
  // structured log, not a metric dimension.
  const emitFailure = (reason) => {
    log?.warn?.('[drs-generation] invoke failure', { reason, market: request.market, siteId: request.siteId });
    try {
      emitMetric({ name: 'DRSInvokeFailure', value: 1 }, metricsOpts);
    } catch { /* metrics are best-effort, never mask the real error */ }
  };

  const invoker = invoke ?? createLambdaInvoker(context);
  const startedAt = Date.now();
  let parsed;
  try {
    parsed = await invoker(functionName, request);
  } catch (error) {
    // A transport/invoke error (including a timeout) is a genuine failure.
    emitFailure('invoke');
    throw error;
  } finally {
    try {
      emitMetric({
        name: 'DRSInvokeDurationMs', value: Date.now() - startedAt, unit: 'Milliseconds',
      }, metricsOpts);
    } catch { /* best-effort */ }
  }
  const body = unwrapDrsBody(parsed);

  const shipSummary = body?.ship_summary ?? {};
  const { verdict } = shipSummary;
  const errorCategory = shipSummary.error_category;

  if (verdict !== 'ship') {
    log?.info?.('[drs-generation] non-ship verdict', {
      siteId: request.siteId, market: request.market, verdict, errorCategory,
    });
    // `held` is a legitimate fail-OPEN business outcome — terminal for the job, but
    // NOT a failure to page on. No failure metric; the reason is only logged.
    if (verdict === 'held') {
      throw new DrsGenerationTerminalError(
        `DRS generation held prompts for market ${request.market}`,
        { verdict, errorCategory, code: GENERATION_ERROR_CODE.HELD },
      );
    }
    // A retryable `gate_error` is transient (retried) — not a terminal failure yet,
    // so it does not increment the paging metric either.
    if (verdict === 'gate_error' && errorCategory === 'retryable') {
      throw retryableJobError(`DRS generation gate_error (retryable) for market ${request.market}`);
    }
    // Everything else here is a genuine terminal failure: a terminal `gate_error`
    // or an unexpected/malformed verdict. This DOES page.
    emitFailure(`verdict:${verdict ?? 'unknown'}`);
    const code = verdict === 'gate_error'
      ? GENERATION_ERROR_CODE.GATE_ERROR
      : GENERATION_ERROR_CODE.TERMINAL;
    throw new DrsGenerationTerminalError(
      `DRS generation did not ship (verdict=${verdict}, error_category=${errorCategory ?? 'none'})`,
      { verdict, errorCategory, code },
    );
  }

  const prompts = Array.isArray(body?.prompts) ? body.prompts : [];
  return {
    prompts,
    languageEvidence: Array.isArray(body?.language_evidence) ? body.language_evidence : undefined,
    shipSummary: { verdict, error_category: errorCategory },
  };
}
