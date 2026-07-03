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

/*
 * POC — AI Marketing Consultant brief endpoint.
 *
 * Flow: gather data-source context (POC: static Lovesac block) -> build a grounding
 * prompt -> call the Adobe Marketing Agent / CoWorker over MCP -> adapt the response
 * into { briefSlides, briefSections } for the Elmo UI.
 *
 * Auth (POC): forwards the caller's IMS token to the agent, or uses AMA_IMS_TOKEN from
 * the local env. This never needs a provisioned service account for a local run.
 *
 * NOT FOR PRODUCTION — proof of concept only.
 */

import { ok, badRequest, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { createAmaClient } from '../support/marketing-agent/ama-client.js';
import { adaptBriefText } from '../support/marketing-agent/brief-adapter.js';
import { getMarketingConsultantContext, buildBriefPrompt } from '../support/marketing-agent/context-builder.js';

/** Extracts a bearer token from the incoming request, if present. */
function extractBearer(context) {
  const headers = context?.pathInfo?.headers || {};
  const raw = headers.authorization
    || headers.Authorization
    || (typeof context?.request?.headers?.get === 'function'
      ? context.request.headers.get('authorization')
      : undefined);
  if (!raw) {
    return undefined;
  }
  return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw;
}

function MarketingConsultantController(context) {
  const { log = console } = context || {};

  /**
   * POST /sites/:siteId/marketing-consultant/brief
   * Generates a GEO strategic brief live via the Adobe Marketing Agent / CoWorker.
   */
  const generateBrief = async (requestContext) => {
    const { siteId } = requestContext.params || {};
    if (!siteId) {
      return badRequest('siteId is required');
    }

    const env = requestContext.env || {};
    const token = env.AMA_IMS_TOKEN || extractBearer(requestContext);
    if (!token) {
      return badRequest(
        'No IMS token available. Forward the Authorization header, or set AMA_IMS_TOKEN in the local env.',
      );
    }

    const contextData = getMarketingConsultantContext();
    const query = buildBriefPrompt(contextData);

    try {
      const client = createAmaClient({
        endpoint: env.AMA_MCP_ENDPOINT,
        toolName: env.AMA_TOOL_NAME,
        token,
        log,
      });
      const text = await client.callAgent(query);
      const { briefSlides, briefSections } = adaptBriefText(text);

      return ok({
        briefSlides,
        briefSections,
        source: 'live',
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      log.error?.(`Marketing brief generation failed for site ${siteId}: ${e.message}`);
      return internalServerError(`Marketing brief generation failed: ${e.message}`);
    }
  };

  return { generateBrief };
}

export default MarketingConsultantController;
