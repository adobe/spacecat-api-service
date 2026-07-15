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
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/**
 * Client for the Cloud Manager (CM) connector Lambda.
 *
 * api-service cannot reach Cloud Manager's private API directly from its own
 * network; a dedicated connector service reaches it (SITES-47815) and this
 * client synchronously invokes that connector Lambda.
 *
 * It is invoked from the post-ack onboarding path only (queueDeliveryConfigWriter),
 * never before the Slack 3s ack — the connector retries a lossy network path
 * and can take a few seconds.
 *
 * All methods degrade gracefully (never throw to the caller) so onboarding is
 * never blocked by CM: when the connector isn't configured/deployed/authorized,
 * they return `{ verified: false, degraded: true }` and log a warning.
 *
 * @class
 */
export class CloudManagerClient {
  /**
   * @param {object} opts
   * @param {string} [opts.region] - AWS region (from context.runtime.region).
   * @param {string} [opts.functionName] - CM connector Lambda name
   *   (env.CM_CONNECTOR_FUNCTION_NAME).
   * @param {object} [opts.log] - logger.
   */
  constructor({ region, functionName, log } = {}) {
    this.functionName = functionName;
    this.log = log;
    this.client = functionName ? new LambdaClient(region ? { region } : {}) : null;
  }

  /** @returns {boolean} whether the connector is configured and can be invoked. */
  get enabled() {
    return Boolean(this.functionName && this.client);
  }

  /**
   * Invoke the connector with an action payload and return its parsed JSON result.
   * @param {object} payload - e.g. { action: 'get_program', programId }.
   * @returns {Promise<object>} the connector's response body.
   * @throws if the connector is not configured or the invocation errors.
   */
  async invokeAction(payload) {
    if (!this.enabled) {
      throw new Error('CloudManager connector is not configured (CM_CONNECTOR_FUNCTION_NAME)');
    }
    const res = await this.client.send(new InvokeCommand({
      FunctionName: this.functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    const text = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
    if (res.FunctionError) {
      throw new Error(`CloudManager connector error (${res.FunctionError}): ${text.slice(0, 300)}`);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`CloudManager connector returned non-JSON: ${text.slice(0, 300)}`);
    }
  }

  /**
   * GET /api/program/{programId}.
   * @param {string} programId
   * @returns {Promise<object>} connector response { ok, statusCode, data }.
   */
  async getProgram(programId) {
    return this.invokeAction({ action: 'get_program', programId });
  }

  /**
   * GET /api/program/{programId}/environments.
   * @param {string} programId
   * @returns {Promise<object>} connector response { ok, statusCode, data }.
   */
  async listEnvironments(programId) {
    return this.invokeAction({ action: 'list_environments', programId });
  }

  /**
   * Best-effort verification that a (host-regex-derived) programId actually
   * exists in Cloud Manager. Never throws — degrades so onboarding continues.
   * @param {string} programId
   * @returns {Promise<{verified: boolean, degraded?: boolean, statusCode?: number,
   *   program?: object, error?: string}>}
   */
  async verifyProgram(programId) {
    if (!this.enabled) {
      this.log?.info('[cloud-manager] connector not configured; skipping program verification');
      return { verified: false, degraded: true };
    }
    if (!programId) {
      return { verified: false, degraded: true };
    }
    try {
      const r = await this.getProgram(programId);
      if (!r?.ok) {
        this.log?.warn(`[cloud-manager] program ${programId} not verified (status ${r?.statusCode})`);
        return { verified: false, statusCode: r?.statusCode, program: r?.data };
      }
      return {
        verified: true, statusCode: r.statusCode, program: r.data,
      };
    } catch (e) {
      this.log?.warn(`[cloud-manager] verifyProgram(${programId}) failed, degrading: ${e.message}`);
      return { verified: false, degraded: true, error: e.message };
    }
  }
}

/**
 * Build a CloudManagerClient from a Lambda context (env + runtime + log).
 * @param {object} context
 * @returns {CloudManagerClient}
 */
export function createCloudManagerClient(context = {}) {
  const { env = {}, runtime = {}, log } = context;
  return new CloudManagerClient({
    region: runtime.region || env.AWS_REGION,
    functionName: env.CM_CONNECTOR_FUNCTION_NAME,
    log,
  });
}
