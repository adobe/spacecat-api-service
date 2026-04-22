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

import {
  badRequest,
  notFound,
  createResponse,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';

function BrandPresenceController(context) {
  const { dataAccess, log } = context;
  const { Site } = dataAccess;

  const ingestMetrics = async (requestContext) => {
    const { siteId } = requestContext.params;
    const { data } = requestContext;

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound(`Site not found: ${siteId}`);
      }

      if (!data || !Array.isArray(data.metrics)) {
        return badRequest('Request body must contain a "metrics" array');
      }

      return createResponse({ message: 'ok' }, 201);
    } catch (err) {
      log.error(`[brand-presence-controller] POST /sites/${siteId}/brand-presence/metrics: ${err.message}`, err);
      return internalServerError('Internal server error');
    }
  };

  return { ingestMetrics };
}

export default BrandPresenceController;
