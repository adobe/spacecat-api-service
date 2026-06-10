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

/* c8 ignore start */
import { MetaResponseSchema } from '@quazar/ai-seo-ts/ai-cr/messages_pb.js';
import { responseFromGrpcError } from '../../../grpc-utils.js';
import { messageToJson } from '../../../proto-json.js';

const WORLDWIDE_COUNTRY = 'WORLDWIDE';
const META_TO_JSON = {
  enumAsInteger: false,
  useProtoFieldName: true,
  alwaysEmitImplicit: true,
};

function dateKey(date) {
  return `${Number(date?.year) || 0}-${Number(date?.month) || 0}-${Number(date?.day) || 0}`;
}

function parseDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

function toRank(date) {
  return (
    (Number(date?.year) || 0) * 10000
    + (Number(date?.month) || 0) * 100
    + (Number(date?.day) || 0)
  );
}

function sortDatesDesc(dates) {
  return [...dates].sort((a, b) => toRank(b) - toRank(a));
}

function sortCountryDates(country) {
  return {
    ...country,
    daily: sortDatesDesc(country.daily || []),
    monthly: sortDatesDesc(country.monthly || []),
  };
}

function computeWorldwideMeta(countries) {
  const withDaily = countries.filter(
    (country) => (country.daily || []).length > 0,
  );
  let worldwideDaily = [];

  if (withDaily.length > 0) {
    const dailySets = withDaily.map(
      (country) => new Set(country.daily.map(dateKey)),
    );
    const intersection = dailySets.reduce(
      (acc, set) => new Set([...acc].filter((key) => set.has(key))),
    );
    worldwideDaily = [...intersection].map(parseDateKey);
  }

  const withMonthly = countries.filter(
    (country) => (country.monthly || []).length > 0,
  );
  const worldwideMonthly = [];

  if (withMonthly.length > 0) {
    const monthlyMax = (max, date) => (toRank(date) > toRank(max) ? date : max);
    const monthlySets = (country) => country.monthly.reduce(monthlyMax);
    const maxPerCountry = withMonthly.map(monthlySets);
    const cutoff = maxPerCountry.reduce((min, date) => (toRank(date) < toRank(min) ? date : min));
    const cutoffRank = toRank(cutoff);

    const seen = new Set();
    withMonthly.forEach((country) => {
      country.monthly.forEach((date) => {
        const key = dateKey(date);
        if (toRank(date) <= cutoffRank && !seen.has(key)) {
          seen.add(key);
          worldwideMonthly.push(date);
        }
      });
    });
  }

  return {
    country: WORLDWIDE_COUNTRY,
    daily: sortDatesDesc(worldwideDaily),
    monthly: sortDatesDesc(worldwideMonthly),
    is_coming_soon: false,
  };
}

export async function handleMeta(_sp, clients) {
  try {
    const raw = await clients.crMetaClient.meta({});
    const metaJson = messageToJson(MetaResponseSchema, raw, META_TO_JSON);
    const countries = Array.isArray(metaJson.countries)
      ? metaJson.countries.map(sortCountryDates)
      : [];

    return {
      status: 200,
      body: {
        ...metaJson,
        countries: [...countries, computeWorldwideMeta(countries)],
      },
    };
  } catch (error) {
    const mapped = responseFromGrpcError(error);
    if (mapped) {
      return mapped;
    }
    throw error;
  }
}
/* c8 ignore stop */
