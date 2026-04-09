# LLMO / Brand Presence Schema Reference

Postgres schema for brand presence. V2 customer config brands are synced to `brands` on save/patch.

---

### brands (brand metadata)

| Field             | Type      | Required | Notes |
|-------------------|-----------|----------|--------|
| id                | uuid      | no       | Default uuid_generate_v7() |
| organization_id   | uuid      | yes      | FK organizations(id). Unique (organization_id, name). |
| site_id           | uuid      | no       | Base site ID (primary URL). FK sites(id). Immutable once set; unique per organization. Brands without a `site_id` are forced to `pending` status on creation. Exposed in the API as `baseSiteId`. |
| name              | text      | yes      | Unique per organization. |
| status            | text      | yes      | Default 'active'. CHECK: 'pending' \| 'active' \| 'deleted'. |
| origin            | category_origin | yes | Default 'human'. Enum: 'human' \| 'ai'. |
| description       | text      | no       | |
| vertical          | text      | no       | |
| aliases           | text[]    | no       | Default '{}'. Alternative names. |
| competitors       | text[]    | no       | Default '{}'. Competitor names. |
| earned_sources    | text[]    | no       | Default '{}'. Earned media domains. |
| social            | text[]    | no       | Default '{}'. Social profile URLs/handles. |
| owned_urls        | text[]    | no       | Default '{}'. URL patterns for owned content. |
| regions           | text[]    | no       | Default '{}'. Region codes (e.g. US, DE, WW). |
| updated_by        | text      | no       | |
| created_at        | timestamptz | no     | Default now(). |
| updated_at        | timestamptz | no     | Default now(). |

---

### categories (prompt/topic grouping per site)

| Field      | Type             | Required | Notes |
|------------|------------------|----------|--------|
| id         | uuid             | no       | Default uuid_generate_v7(). |
| site_id    | uuid             | yes      | FK sites(id). Unique (site_id, name). |
| name       | text             | yes      | |
| origin     | category_origin  | no       | Default 'human'. 'human' \| 'ai'. |
| updated_by | text             | no       | |
| created_at | timestamptz      | no       | Default now(). |
| updated_at | timestamptz      | no       | Default now(). |

---

### regions (reference — usually read-only)

| Field      | Type        | Required | Notes |
|------------|-------------|----------|--------|
| id         | uuid        | no       | Default uuid_generate_v7(). |
| code       | text        | yes      | Unique (e.g. US, WW, DE). |
| name       | text        | yes      | |
| created_at | timestamptz | no       | Default now(). |
| updated_at | timestamptz | no       | Default now(). |

---

### source_urls (URL deduplication for sources)

| Field      | Type        | Required | Notes |
|------------|-------------|----------|--------|
| id         | uuid        | no       | Default uuid_generate_v7(). Return this for brand_presence_sources.url_id. |
| url        | text        | yes      | url_hash (md5) and hostname are generated. |
| created_at | timestamptz | no       | Default now(). |

---

### brand_presence_executions (raw LLM execution rows)

Partitioned by execution_date. organization_id is set from site on insert (trigger).

| Field                  | Type    | Required | Notes |
|------------------------|---------|----------|--------|
| id                     | uuid    | no       | Default uuid_generate_v7(). PK is (id, execution_date). |
| site_id                | uuid    | yes      | FK sites(id). |
| execution_date         | date    | yes      | Partition key. |
| model                  | llm_model | yes   | Enum: chatgpt-paid, chatgpt-free, google-ai-overview, perplexity, google-ai-mode, copilot, gemini, google, microsoft, mistral, anthropic, amazon. |
| brand_id               | uuid    | no       | FK brands(id). |
| brand_name             | text    | yes      | Denormalized. |
| category_id            | uuid    | no       | FK categories(id). |
| category_name         | text    | yes      | Denormalized. |
| topics                 | text    | no       | |
| prompt                 | text    | no       | |
| origin                 | text    | no       | human \| ai. |
| volume                 | integer | no       | |
| region_code           | text    | yes      | Match regions.code (e.g. US, WW). |
| url                    | text    | no       | |
| answer                 | text    | no       | |
| citations              | boolean | no       | |
| mentions               | boolean | no       | |
| sentiment              | text    | no       | positive \| neutral \| negative. |
| business_competitors   | text    | no       | |
| position               | text    | no       | |
| visibility_score       | integer | no       | |
| citation_score         | integer | no       | |
| detected_brand_mentions| text    | no       | |
| error_code             | text    | no       | |
| created_at             | timestamptz | no    | Default now(). |
| updated_at             | timestamptz | no    | Default now(). |

---

### brand_presence_sources (source URLs per execution)

Partitioned by execution_date. One row per source URL per execution. organization_id set from site on insert.

| Field          | Type                | Required | Notes |
|----------------|---------------------|----------|--------|
| id             | uuid                | no       | Default uuid_generate_v7(). PK (id, execution_date). |
| execution_id   | uuid                | yes      | FK brand_presence_executions(id). |
| execution_date | date                | yes      | Must match parent execution. FK (execution_id, execution_date). |
| site_id        | uuid                | yes      | FK sites(id). |
| model          | text                | yes      | |
| url_id         | uuid                | yes      | FK source_urls(id). Insert into source_urls first. |
| content_type   | source_content_type | yes      | Enum: 'owned' \| 'competitor' \| 'social' \| 'earned'. |
| is_owned       | boolean             | no       | Generated (content_type = 'owned'). |
| created_at     | timestamptz         | no       | Default now(). |

---

### brand_metrics_weekly (pre-aggregated weekly metrics)

organization_id set from site on insert.

| Field           | Type    | Required | Notes |
|-----------------|---------|----------|--------|
| id              | uuid    | no       | Default uuid_generate_v7(). |
| site_id         | uuid    | yes      | FK sites(id). |
| week            | text    | yes      | Format: YYYY-Wnn (e.g. 2025-W01). |
| model           | text    | no       | |
| brand_id        | uuid    | no       | FK brands(id). |
| brand_name      | text    | no       | |
| category_id     | uuid    | no       | FK categories(id). |
| category_name   | text    | no       | |
| region_code     | text    | no       | |
| topic           | text    | no       | |
| competitors     | text    | no       | |
| mentions_count  | integer | no       | Default 0. |
| citations_count | integer | no       | Default 0. |
| prompt_count    | integer | no       | Default 0. |
| created_at      | timestamptz | no    | Default now(). |
| updated_at      | timestamptz | no    | Default now(). |

Unique: (site_id, week, model, brand_name, category_name, region_code, topic) NULLS NOT DISTINCT.

---

### executions_competitor_data (competitor breakdown)

Partitioned by execution_date. organization_id set from site on insert.

| Field           | Type        | Required | Notes |
|-----------------|-------------|----------|--------|
| id              | uuid        | no       | Default uuid_generate_v7(). PK (id, execution_date). |
| site_id         | uuid        | yes      | FK sites(id). |
| execution_date  | date        | yes      | |
| model           | text        | yes      | |
| brand_id        | uuid        | no       | FK brands(id). |
| brand_name      | text        | no       | |
| category_id     | uuid        | no       | FK categories(id). |
| category_name   | text        | no       | |
| competitor      | text        | no       | |
| mentions        | integer     | no       | |
| citations       | integer     | no       | |
| sources         | text        | no       | |
| region_code     | text        | no       | |
| created_at      | timestamptz | no       | Default now(). |
| updated_at      | timestamptz | no       | Default now(). |

---

### Enums

- **category_origin**: 'human' | 'ai'
- **source_content_type**: 'owned' | 'competitor' | 'social' | 'earned'

---

### Read-only / views (no insert)

- **brand_presence_topics_by_date** — materialized view; refresh via refresh_brand_presence_views().
- **brand_presence_prompts_by_date** — materialized view; refresh via refresh_brand_presence_views().

---

### Minimal insert examples (PostgREST / API)

**Brand (metadata):**
- POST /brands { "organization_id": "<org_uuid>", "name": "Adobe", "regions": ["US", "WW"], "status": "active", "origin": "human" }

**Source URL then source row:**
- POST /source_urls { "url": "https://adobe.com/page" } → get id.
- POST /brand_presence_sources { "execution_id": "<exec_id>", "execution_date": "2025-02-26", "site_id": "<site_uuid>", "model": "chatgpt", "url_id": "<source_urls.id>", "content_type": "owned" }

---

## V2 → brands mapping

| V2 field | brands column |
|----------|---------------|
| organizationId | organization_id |
| brand.name | name |
| brand.status | status |
| brand.origin | origin |
| brand.description | description |
| brand.vertical | vertical |
| brand.brandAliases | aliases |
| brand.competitors | competitors |
| brand.region | regions |
| brand.urls | owned_urls |
| brand.socialAccounts | social |
| brand.earnedContent | earned_sources |
| auth user | updated_by |
