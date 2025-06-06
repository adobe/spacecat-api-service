/*
 * Copyright 2025 Adobe. All rights reserved.
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

import {
  badRequest, ok,
} from '@adobe/spacecat-shared-http-utils';

import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { series, DataChunks, utils } from '@adobe/rum-distiller';

export async function loadBundles(url, date, domainkey) {
  const endpoint = `https://bundles.aem.page/bundles/${url}/${date}?domainkey=${domainkey}`;
  const resp = await fetch(endpoint);
  const data = await resp.json();

  return data;
}

function filterBundlesByUrl(url, allBundles) {
  try {
    const target = new URL(url);
    const targetPath = target.pathname;

    const shouldFilter = targetPath && targetPath !== '/';

    return shouldFilter
      ? allBundles.filter((b) => {
        try {
          return new URL(b.url).pathname === targetPath;
        } catch {
          return false;
        }
      })
      : allBundles;
  } catch {
    return allBundles;
  }
}

/**
 * Get the latest audit for a given site and audit type.
 *
 * @param {string} siteId - UUID of the site.
 * @param {string} auditType - Audit type (e.g., 'cwv', 'lhs-desktop', etc.).
 * @param {object} [extraHeaders] - Optional additional headers (e.g., org ID, authorization).
 * @returns {Promise<object>} - The latest audit result.
 */
export async function getDataChunks(url, domainkey, startdate, enddate) {
  if (!url || !domainkey) {
    throw new Error('Both url and domainkey are required.');
  }
  let start;
  let end;

  if (!startdate || !enddate) {
    start = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    end = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  } else {
    start = new Date(startdate);
    end = new Date(enddate);
  }

  const dateList = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dateList.push(d.toISOString().slice(0, 10).replace(/-/g, '/'));
  }

  const r = (await Promise.all(dateList.map((date) => loadBundles(url, date, domainkey)))).flat();

  return r;
}

/**
 * Get the relevant statistic for a DataChunk.
 *
 * @param {string} dataChunks - Rum Bundle Datachunks.
 * @param {string} aggregation - Statistic Agent Needs (pageviews, lcp, inp, etc.).
 * @returns {Promise<object>} - The relevant statistic.
 */
export async function getStatistic(url, dataChunks, aggregation) {
  if (!dataChunks || !aggregation) {
    throw new Error('dataChunks, aggregation, and statistic are required.');
  }

  let aggHandler;

  if (aggregation === 'pageviews') {
    aggHandler = series.pageViews;
  } else if (aggregation === 'visits') {
    aggHandler = series.visits;
  } else if (aggregation === 'bounces') {
    aggHandler = series.bounces;
  } else if (aggregation === 'organic') {
    aggHandler = series.organic;
  } else if (aggregation === 'earned') {
    aggHandler = series.earned;
  } else if (aggregation === 'lcp') {
    aggHandler = series.lcp;
  } else if (aggregation === 'cls') {
    aggHandler = series.cls;
  } else if (aggregation === 'inp') {
    aggHandler = series.inp;
  } else if (aggregation === 'ttfb') {
    aggHandler = series.ttfb;
  } else if (aggregation === 'engagement') {
    aggHandler = series.engagement;
  } else {
    throw new Error(`Unsupported aggregation: ${aggregation}`);
  }

  dataChunks.forEach((chunk) => {
    // eslint-disable-next-line no-param-reassign
    chunk.rumBundles = chunk.rumBundles.map(utils.addCalculatedProps);
  });

  const d = new DataChunks();
  d.load(dataChunks);
  d.filteredIn = filterBundlesByUrl(url, d.bundles);
  d.addSeries(aggregation, aggHandler);
  d.group((b) => b.url);

  const resultList = [];
  for (const [urlL, metrics] of Object.entries(d.aggregates)) {
    const metric = metrics[aggregation];
    if (metric && metric.count > 0) {
      resultList.push({
        urlL,
        count: metric.count,
        sum: metric.sum,
        mean: metric.mean,
        p50: metric.percentile(50),
        p75: metric.percentile(75),
      });
    }
  }
  return resultList;
}

/**
 * Bundles controller.
 * @param {object} ctx - Context object.
 * @returns {object} Bundles controller.
 * @constructor
 */
function BundlesController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  /**
 * Gets all bundles for a given url, and date range.
 *
 * @returns {Promise<Response>} Array of bundles response.
 */
  const getAllBundles = async (context) => {
    const url = context.params?.url || undefined;
    const domainkey = context.params?.domainkey || undefined;
    const startDate = context.params?.startdate || undefined;
    const endDate = context.params?.enddate || undefined;
    const aggregation = context.params?.aggregation;

    if (!url || !domainkey || !aggregation) {
      return badRequest('URL, domainKey, and aggregation are required');
    }

    const dataChunks = await getDataChunks(url, domainkey, startDate, endDate, aggregation);
    const stats = await getStatistic(url, dataChunks, aggregation);
    return ok(stats);
  };

  return {
    getAllBundles,
  };
}

export default BundlesController;

/* c8 ignore end */
