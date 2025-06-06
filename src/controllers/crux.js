/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ok } from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { fetchCruxData } from '../support/crux-client.js';

function CRUXController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { env } = ctx;
  const { CRUX_API_KEY } = env;

  const getCRUXDataByURL = async (context) => {
    if (!CRUX_API_KEY) {
      throw new Error('CRUX_API_KEY is not set');
    }

    const { url, formFactor } = context.params;
    const cruxData = await fetchCruxData({ url, formFactor, apiKey: CRUX_API_KEY });
    return ok(cruxData, { 'Content-Type': 'application/json' });
  };

  return { getCRUXDataByURL };
}

export default CRUXController;
