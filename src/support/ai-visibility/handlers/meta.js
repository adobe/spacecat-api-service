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

import { MetaResponseSchema } from '@quazar/ai-seo-ts/ai-cr/messages_pb.js';
import { COUNTRY_ENUM } from '../grpc-utils.js';
import { messageToJson } from '../proto-json.js';

export async function handleMeta(_sp, clients) {
  const raw = await clients.crMetaClient.meta({});
  const json = messageToJson(MetaResponseSchema, raw);
  const countries = (json.countries || []).map((c) => ({
    countryCode: COUNTRY_ENUM[c.country] || String(c.country),
    daily: c.daily || [],
    monthly: c.monthly || [],
    isComingSoon: Boolean(c.isComingSoon),
  }));
  return { status: 200, body: { countries } };
}
