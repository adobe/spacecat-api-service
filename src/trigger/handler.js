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

import { Response } from '@adobe/fetch';
import cwv from './cwv.js';

const AUDITS = {
  cwv,
};

export default async function triggerHandler(context) {
  const { log, data } = context;
  const { type, url } = data;

  if (!type || !url) {
    return new Response('', {
      status: 400,
      headers: {
        'x-error': 'required query params missing',
      },
    });
  }

  const audit = AUDITS[type];

  if (!audit) {
    return new Response('', {
      status: 400,
      headers: {
        'x-error': 'unknown audit type',
      },
    });
  }

  try {
    return await audit(context);
  } catch (e) {
    log.error(`Failed to trigger ${type} audit for ${url}`, e);
    throw new Error(`Failed to trigger ${type} audit for ${url}`);
  }
}
