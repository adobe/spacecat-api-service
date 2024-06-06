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

/**
 * RUM controller.
 * @returns {object} RUM controller.
 * @constructor
 */

import { badRequest, ok } from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';

function RUMController() {
  const queryRUM = async (context) => {
    const { query } = context.params;

    const {
      domain,
      domainkey,
      interval,
      granularity,
    } = context.data;

    if (!hasText(domain) || !hasText(domainkey)) {
      return badRequest('Parameters domain and domainkey are required');
    }

    const rumapiClient = RUMAPIClient.createFrom(context);

    const result = rumapiClient.query(query, {
      domain,
      domainkey,
      interval,
      granularity,
    });

    return ok(result);
  };

  return {
    queryRUM,
  };
}

export default RUMController;
