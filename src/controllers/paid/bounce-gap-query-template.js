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
 * Generates an Athena SQL query template for bounce gap analysis.
 * This query includes BOTH consent states (show/hidden) to enable bounce gap loss calculation.
 *
 *
 * @param {Object} params - Query parameters
 * @param {string} params.siteId - Site ID
 * @param {string} params.tableName - Full table name (database.table)
 * @param {string} params.temporalCondition - Temporal condition (e.g., "week=1 AND year=2024")
 * @param {string} params.dimensionColumns - Comma-separated dimension columns
 *   (e.g., "path, trf_type")
 * @param {string} params.groupBy - GROUP BY clause (same as dimensionColumns)
 * @param {string} params.dimensionColumnsPrefixed - Prefixed dimension columns
 *   (e.g., "a.path, a.trf_type")
 * @param {number|null} params.limit - Result limit (null for no limit)
 * @returns {string} SQL query string
 */
export function getTop3PagesWithBounceGapTemplate({
  siteId,
  tableName,
  temporalCondition,
  dimensionColumns,
  groupBy,
  dimensionColumnsPrefixed,
  limit,
}) {
  return `
WITH raw AS (
    SELECT
        week,
        month,
        path,
        trf_type,
        trf_channel,
        trf_platform,
        device,
        utm_source,
        utm_medium,
        utm_campaign,
        referrer,
        consent,
        notfound,
        pageviews,
        clicked,
        engaged,
        latest_scroll,
        CASE WHEN latest_scroll >= 10000 THEN 1 ELSE 0 END AS engaged_scroll,
        lcp,
        cls,
        inp
    FROM ${tableName}
    WHERE siteid = '${siteId}'
    AND (${temporalCondition})
    AND consent IN ('show', 'hidden')
),
agg AS (
    SELECT
        ${dimensionColumns},
        consent,
        COUNT(*)                          AS row_count,
        CAST(SUM(pageviews) AS BIGINT)   AS pageviews,
        CAST(SUM(clicked) AS BIGINT)     AS clicks,
        CAST(SUM(engaged) AS BIGINT)     AS engagements,
        CAST(SUM(engaged_scroll) AS BIGINT) AS engaged_scroll,
        approx_percentile(latest_scroll, 0.70) AS p70_scroll,
        approx_percentile(lcp, 0.70)     AS p70_lcp,
        approx_percentile(cls, 0.70)     AS p70_cls,
        approx_percentile(inp, 0.70)     AS p70_inp
    FROM raw
    GROUP BY ${groupBy}, consent
),
grand_total AS (
    SELECT CAST(SUM(pageviews) AS BIGINT) AS total_pv FROM agg WHERE consent = 'show'
)
SELECT
    ${dimensionColumnsPrefixed},
    a.consent,
    CAST(a.pageviews AS DOUBLE) * (1 - CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)) AS traffic_loss,
    1 - CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)  AS bounce_rate,
    a.pageviews,
    CAST(a.pageviews AS DOUBLE) / NULLIF(t.total_pv, 0)         AS pct_pageviews,
    CAST(a.clicks AS DOUBLE)      / NULLIF(a.row_count, 0)      AS click_rate,
    CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)      AS engagement_rate,
    CAST(a.engaged_scroll AS DOUBLE) / NULLIF(a.row_count, 0) AS engaged_scroll_rate,
    a.p70_scroll,
    a.p70_lcp,
    a.p70_cls,
    a.p70_inp
FROM agg a
CROSS JOIN grand_total t
ORDER BY traffic_loss DESC
${limit ? `LIMIT ${limit}` : ''}
`.trim();
}
