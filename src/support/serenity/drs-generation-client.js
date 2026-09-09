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
   * @param {object} [details] - `{ verdict, errorCategory }` for observability.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'DrsGenerationTerminalError';
    /** @type {any} */ (this).code = 'DRS_GENERATION_TERMINAL';
    /** @type {any} */ (this).details = details;
  }
}

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
    const response = await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));

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

  const invoker = invoke ?? createLambdaInvoker(context);
  const parsed = await invoker(functionName, request);
  const body = unwrapDrsBody(parsed);

  const shipSummary = body?.ship_summary ?? {};
  const { verdict } = shipSummary;
  const errorCategory = shipSummary.error_category;

  if (verdict !== 'ship') {
    log?.info?.('[drs-generation] non-ship verdict', {
      siteId: request.siteId, market: request.market, verdict, errorCategory,
    });
    // `gate_error` with a `retryable` category is the ONLY retryable non-ship
    // outcome; `held` and any `terminal` category fail the job (never publish an
    // empty/held market).
    if (verdict === 'gate_error' && errorCategory === 'retryable') {
      throw retryableJobError(`DRS generation gate_error (retryable) for market ${request.market}`);
    }
    throw new DrsGenerationTerminalError(
      `DRS generation did not ship (verdict=${verdict}, error_category=${errorCategory ?? 'none'})`,
      { verdict, errorCategory },
    );
  }

  const prompts = Array.isArray(body?.prompts) ? body.prompts : [];
  return {
    prompts,
    languageEvidence: Array.isArray(body?.language_evidence) ? body.language_evidence : undefined,
    shipSummary: { verdict, error_category: errorCategory },
  };
}
