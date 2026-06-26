# ADR-006: Serenity (Semrush) v1/v2 read drift — which layer each read sees

## Context

The Serenity transport (`src/support/serenity/rest-transport.js`) talks to the
Semrush Project Engine through two API versions, `/v1` and `/v2`, and the choice
is **not** "prefer v2 everywhere". The two versions read **different layers of a
project's state**, and getting the version wrong silently misreads an unpublished
draft as empty or as the wrong geo. This was surfaced while reviewing the
all-PAID Semrush migration readiness (serenity-docs#18) and is tracked as one of
the implementation adjustments in
https://github.com/adobe/spacecat-api-service/issues/2687 .

A Semrush AIO project has a **draft layer** and a **live (published) layer**.
Mutations (settings, AI-model assignments, prompts) stage in the draft layer and
only reach the live layer on `publishProject`. The two API versions expose these
layers differently:

- **Project SETTINGS** (name, brand_names, language, country, location, model
  set): the **v1 default view is draft-faithful**. The v2 list (and v1 with
  `live=true`) returns a **live-view materialisation** — for a never-published
  draft it defaults the location to US/2840 and nulls `brand_names`, giving the
  wrong slice identity. Verified live 2026-06-11 against the prod tenant.
- **Prompt layer** (counts, lists, tags): reads **only the live layer**, and
  there is **no v1 variant at all** — `aio/prompts/by_tags` exists only on
  `/v2`. A populated-but-unpublished draft reads **empty**. This is the source of
  every "201-but-count-0" symptom.
- **Init status** (`aio/init_status`, an AIO-readiness boolean): moved from `/v1`
  to `/v2` in `@adobe/spacecat-shared-project-engine-client` **1.2.0** (the v1
  route was removed from the generated contract). It is a readiness flag, not
  draft settings, so the v2 live-view carries no draft-faithfulness concern.

## Decision

Each Serenity read picks its API version by **which layer it must observe**, not
by a blanket "use the newest version" rule:

| Read | Version | Layer | Why |
|------|---------|-------|-----|
| `listProjects` (`GET /projects?type=ai`) | **v1** | draft | draft-faithful settings; v2 list returns live-view with wrong location/null brand_names |
| `getProject` (`GET /projects/{id}?draft=true&type=ai`) | **v1** | draft | single-project draft settings; `draft` query is required upstream |
| `listPromptsByTags` (`POST /aio/prompts/by_tags`) | **v2** | live | no v1 variant exists; prompt layer is live-only |
| `getInitStatus` (`GET /aio/init_status`) | **v2** | n/a | readiness boolean; v1 route removed in client 1.2.0 |
| writes that need to go live (`addAiModel`, `createTaggedPrompts`, …) | mixed | draft → publish | mutations stage in draft; `publishProject` commits them |

Consequences for **migration-verification / UI-enrichment reads**:

- Treat a v2 prompt/tag read of **0** on an **unpublished** project as
  "not yet published", **never** as "migration didn't land". Publish first (or
  read after the known publish), then re-read.
- Never read draft project **settings** through the v2 project list — its
  location/brand_names are a live-view default, not the draft's real values.
- Model-set edits via `PUT /serenity/models` republish by default
  (`syncModelsForProject({ publish: true })`) precisely so the new set reaches
  the live layer that subsequent reads observe; the only `publish: false` caller
  is brand-create, which batches one final publish itself.

## Status

Accepted. The transport already reads settings via v1 (`listProjects`,
`getProject`) and prompts via v2 (`listPromptsByTags`); this ADR records the
**reason** so the choice is not "corrected" into a uniform v2 swap. The
per-method v1/v2 audit map lives alongside the transport methods' JSDoc. Future
prompt-layer reads inherit the live-only constraint until/unless Semrush ships a
draft-faithful prompt read.
