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

import { tracingFetch as fetch } from '@adobe/spacecat-shared-utils';

/**
 * Client for interacting with the Data Retrieval Service (DRS) API.
 * Used to submit prompt generation jobs for LLMO onboarding.
 *
 * @param {object} context - The request context
 * @returns {object} DRS client with methods for submitting jobs
 */
export default function DrsClient(context) {
  const { env, log } = context;
  const drsApiUrl = env.DRS_API_URL;
  const drsApiKey = env.DRS_API_KEY;

  /**
   * Checks if the DRS client is properly configured.
   * @returns {boolean} True if DRS_API_URL and DRS_API_KEY are set
   */
  function isConfigured() {
    return Boolean(drsApiUrl && drsApiKey);
  }

  /**
   * Submits a prompt generation job to DRS.
   *
   * @param {object} params - Job parameters
   * @param {string} params.baseUrl - The base URL of the site
   * @param {string} params.brandName - The brand name
   * @param {string} params.audience - Target audience description
   * @param {string} [params.region='US'] - Geographic region for prompts
   * @param {number} [params.numPrompts=40] - Number of prompts to generate
   * @param {string} params.siteId - The SpaceCat site ID
   * @param {string} params.imsOrgId - The Adobe IMS organization ID
   * @returns {Promise<object>} Job submission result with job_id
   * @throws {Error} If job submission fails or DRS is not configured
   */
  async function submitPromptGenerationJob({
    baseUrl,
    brandName,
    audience,
    region = 'US',
    numPrompts = 40,
    siteId,
    imsOrgId,
  }) {
    if (!isConfigured()) {
      throw new Error('DRS client is not configured. Set DRS_API_URL and DRS_API_KEY environment variables.');
    }

    const spacecatApiUrl = env.SPACECAT_API_URL;
    const callbackApiKey = env.DRS_CALLBACK_API_KEY;

    if (!callbackApiKey) {
      log.warn('DRS_CALLBACK_API_KEY not configured, webhook notifications will not be sent');
    }

    const webhookUrl = callbackApiKey && spacecatApiUrl
      ? `${spacecatApiUrl}/hooks/drs/prompt-generation`
      : undefined;

    const payload = {
      provider_id: 'prompt_generation_base_url',
      parameters: {
        base_url: baseUrl,
        brand_name: brandName,
        audience,
        region,
        num_prompts: numPrompts,
      },
      metadata: {
        site_id: siteId,
        imsOrgId,
        base_url: baseUrl,
        brand: brandName,
        region,
      },
    };

    // Only include webhook config if callback API key is configured
    if (webhookUrl && callbackApiKey) {
      payload.webhook_url = webhookUrl;
      payload.webhook_api_key = callbackApiKey;
    }

    log.info(`Submitting DRS prompt generation job for site ${siteId}`, {
      baseUrl,
      brandName,
      region,
      numPrompts,
      hasWebhook: Boolean(webhookUrl),
    });

    const response = await fetch(`${drsApiUrl}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': drsApiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DRS job submission failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    log.info(`DRS job submitted successfully: ${result.job_id}`, {
      siteId,
      jobId: result.job_id,
    });

    return result;
  }

  return {
    isConfigured,
    submitPromptGenerationJob,
  };
}
