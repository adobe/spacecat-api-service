WITH raw AS (
    SELECT
        trf_type,
        path,
        trf_channel,
        utm_campaign,
        trf_platform
        device,
        pageviews,
        clicked,
        engaged,
        lcp,
        cls,
        inp
    FROM {{tableName}}
    WHERE siteid = '{{siteId}}'
        AND year IN ({{years}})
        AND month IN ({{months}})
        AND week = {{week}}
),
  
agg AS (
    SELECT
        {{dimensionColumns}},
        COUNT(*)                          AS row_count,
        CAST(SUM(pageviews) AS BIGINT)    AS pageviews,
        CAST(SUM(clicked) AS BIGINT)      AS clicks,
        CAST(SUM(engaged) AS BIGINT)      AS engagements,
        approx_percentile(lcp, 0.70)      AS p70_lcp,
        approx_percentile(cls, 0.70)      AS p70_cls,
        approx_percentile(inp, 0.70)      AS p70_inp
    FROM raw
    GROUP BY
        {{groupBy}}
),
  
grand_total AS (
    SELECT CAST(SUM(pageviews) AS BIGINT) AS total_pv FROM agg
)
  
SELECT
    {{dimensionColumnsPrefixed}}
    a.pageviews,
  
    CAST(a.pageviews AS double) / NULLIF(t.total_pv, 0)            AS pct_pageviews,
    CAST(a.clicks AS double)      / NULLIF(a.row_count, 0)         AS click_rate,
    CAST(a.engagements AS double) / NULLIF(a.row_count, 0)         AS engagement_rate,
    1 - CAST(a.engagements AS double) / NULLIF(a.row_count, 0)     AS bounce_rate,
  
    a.p70_lcp,
    a.p70_cls,
    a.p70_inp
  
FROM agg a
CROSS JOIN grand_total t
ORDER BY a.pageviews DESC