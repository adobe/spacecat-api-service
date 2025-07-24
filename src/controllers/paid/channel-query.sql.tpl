WITH raw AS (
    SELECT
        path,
        {{pageTypeCase}},   
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
    FROM {{tableName}}
    WHERE siteid = '{{siteId}}'
    AND ({{temporalCondition}})
),
agg AS (
    SELECT
        {{dimensionColumns}},
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
    GROUP BY {{groupBy}}
),
grand_total AS (
    SELECT CAST(SUM(pageviews) AS BIGINT) AS total_pv FROM agg
)
SELECT
    {{dimensionColumnsPrefixed}},
    a.pageviews,
    CAST(a.pageviews AS DOUBLE) / NULLIF(t.total_pv, 0)         AS pct_pageviews,
    CAST(a.clicks AS DOUBLE)      / NULLIF(a.row_count, 0)      AS click_rate,
    CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)      AS engagement_rate,
    1 - CAST(a.engagements AS DOUBLE) / NULLIF(a.row_count, 0)  AS bounce_rate,
    a.engaged_scroll,
    a.p70_scroll,
    a.p70_lcp,
    a.p70_cls,
    a.p70_inp
FROM agg a
CROSS JOIN grand_total t
ORDER BY a.pageviews DESC