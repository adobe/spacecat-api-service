/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { hasText } from '@adobe/spacecat-shared-utils';

import { badRequest } from '@adobe/spacecat-shared-http-utils';
import apex from './trigger/apex.js';
import cwv from './trigger/cwv.js';
import lhs from './trigger/lhs.js';
import notfound from './trigger/notfound.js';
import backlinks from './trigger/backlinks.js';
import keywords from './trigger/keywords.js';

const AUDITS = {
  apex,
  cwv,
  'lhs-mobile': lhs,
  'lhs-desktop': lhs,
  lhs, // for all lhs variants
  404: notfound,
  'broken-backlinks': backlinks,
  'organic-keywords': keywords,
};

/**
 * Trigger handler.
 * @param {object} context - Context.
 * @return {Promise<Response|*>} Response.
 */
export default async function triggerHandler(context) {
  const { log, data } = context;
  const { type, url } = data;

  log.info(`AUDIT TRIGGERED ${type} ${url}}`);

  if (!hasText(type) || !hasText(url)) {
    return badRequest('required query params missing');
  }

  const audit = AUDITS[type];

  if (!audit) {
    return badRequest('unknown audit type');
  }

  try {
    return await audit(context);
  } catch (e) {
    log.error(`Failed to trigger ${type} audit for ${url}`, e);
    throw new Error(`Failed to trigger ${type} audit for ${url}`);
  }
}
