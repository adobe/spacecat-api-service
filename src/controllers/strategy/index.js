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

import { createResponse } from '@adobe/spacecat-shared-http-utils';
import { enableExperimentTrackingHandler } from './experiment-tracking.js';
import { linkGeoExperiment } from '../../support/strategy/geo-experiment-stub.js';

/**
 * Adapts the dependency-injected Express-style handler in
 * `experiment-tracking.js` to the context-style controller method shape used
 * by `src/routes/index.js`. The handler stays test-friendly (pure deps); this
 * wrapper bridges to the real spacecat HTTP runtime.
 */
function StrategyController(_) {
  const enableExperimentTracking = async (ctx) => {
    let statusCode = 200;
    let body;
    const fakeRes = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        body = payload;
        return this;
      },
    };
    const fakeReq = {
      params: ctx.params,
      body: ctx.data,
      auth: { actor: ctx.attributes?.authInfo?.profile?.email || ctx.pathInfo?.headers?.['x-actor'] || 'unknown' },
    };

    // TODO(experiment-team): wire real strategy data access + audit log
    // once the lock-policy spec ships. For demo: persist via S3-backed
    // strategy storage is intentionally stubbed at the data-access layer.
    const deps = {
      getStrategy: async () => null,
      persist: async () => {},
      audit: async () => {},
      linkGeoExperiment,
    };

    await enableExperimentTrackingHandler(deps)(fakeReq, fakeRes);
    return createResponse(body, statusCode);
  };

  return { enableExperimentTracking };
}

export default StrategyController;
