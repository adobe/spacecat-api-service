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

/**
 * Shared logic for relocating a full LLMO ("brandalf") entity graph from one
 * organization to another.
 *
 * Historically the Slack "Update IMS Org" flow only reassigned `sites.organization_id`,
 * which stranded every brand-centric entity (brands, prompts, topics, categories,
 * competitors, feature flags) in the source org. Now that the product navigates by
 * brand rather than by site, that left customers with an empty destination org and an
 * orphaned source org (LLMO-7294).
 *
 * The relocation itself is delegated to two PostgREST functions in
 * mysticat-data-service, NOT to the data-access models:
 *
 *  - `rpc_org_move_preview`  - read-only; reports what would move and what conflicts.
 *  - `wrpc_move_brandalf_org` - performs the move in a single transaction.
 *
 * An RPC is required rather than a sequence of model writes because
 * `feature_flags_organization_id_brand_id_fkey` is a composite foreign key
 * `(organization_id, brand_id) -> brands(organization_id, id)`. Updating `brands` and
 * `feature_flags` as two separate statements transiently violates that constraint in
 * whichever order they are attempted, so the update must happen inside one
 * data-modifying CTE. The `Brand` data-access model also deliberately does not expose
 * a setter for `organization_id`.
 */

const PREVIEW_RPC = 'rpc_org_move_preview';
const MOVE_RPC = 'wrpc_move_brandalf_org';

/**
 * Above these counts the move is flagged as unusually large in the preview. The move is
 * still allowed - it runs in a single transaction, so a large move is not a corruption
 * risk - but a source org holding this many sites or active brands is a strong hint the
 * operator resolved the wrong org and is about to relocate an unrelated customer.
 */
export const LARGE_MOVE_SITE_THRESHOLD = 5;
export const LARGE_MOVE_BRAND_THRESHOLD = 5;

/**
 * Entitlements and site enrollments are deliberately out of scope for the move
 * (LLMO-7294). `site_enrollments` has no `organization_id` - it reaches the org only
 * indirectly via `entitlement_id` - so entitlements cannot be re-pointed by the same
 * org-id rewrite that moves everything else, and cloning them 1:1 across tenants is a
 * billing decision this tooling should not make on its own.
 *
 * The caller re-runs the normal LLMO entitlement/enrollment provisioning against the
 * destination org after the move, which grants correct access there but leaves the
 * source org's now-unused enrollment in place. See the LLMO Troubleshooting wiki.
 */
export const ENTITLEMENT_GOTCHA = ':warning: *Entitlements are not moved.* A fresh LLMO '
  + 'entitlement/enrollment is provisioned on the destination org, but the source org\'s '
  + 'existing entitlement and its site enrollment are left untouched and must be revoked '
  + 'manually if the customer should no longer be billed there.';

/**
 * Tables reported by the preview, in the order they are rendered. Keys match the
 * `counts` object returned by `rpc_org_move_preview`.
 */
const COUNT_LABELS = [
  ['brands', 'Brands'],
  ['brand_aliases', 'Brand aliases'],
  ['brand_sites', 'Brand sites'],
  ['brand_urls', 'Brand URLs'],
  ['brand_social_accounts', 'Social accounts'],
  ['brand_earned_sources', 'Earned sources'],
  ['categories', 'Categories'],
  ['topics', 'Topics'],
  ['prompts', 'Prompts'],
  ['topic_prompts', 'Topic prompts'],
  ['category_prompts', 'Category prompts'],
  ['competitors', 'Competitors'],
  ['feature_flags', 'Feature flags'],
  ['sites', 'Sites'],
];

const BLOCKING_CONFLICT_LABELS = {
  brand_name: 'A brand with this name already exists in the destination org',
  brand_base_site: 'A brand in the destination org already uses this site',
};

/**
 * PostgREST returns a scalar-returning function's payload either bare or wrapped in a
 * single-element array depending on the negotiated representation. Normalise both.
 *
 * @param {*} data - Raw `data` from a postgrest-js `.rpc()` call.
 * @returns {object|null} The unwrapped payload.
 */
function unwrap(data) {
  if (Array.isArray(data)) {
    return data.length > 0 ? data[0] : null;
  }
  return data ?? null;
}

/**
 * @param {object} context - Lambda context.
 * @returns {object} The PostgREST client.
 * @throws {Error} If the client is unavailable.
 */
function resolvePostgrestClient(context) {
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.rpc) {
    throw new Error('PostgREST client is unavailable; cannot move the organization.');
  }
  return postgrestClient;
}

/**
 * Reports what a move from `sourceOrgId` to `destOrgId` would do. Read-only.
 *
 * Never throws on a business-level problem: an unevaluable request (unknown org, same
 * org) comes back as `{ ok: false, error: <code> }`, and a genuine blocking conflict
 * comes back as `{ ok: false, blocking_conflicts: [...] }` with no `error` key. Only
 * transport/database failures throw.
 *
 * @param {object} context - Lambda context.
 * @param {string} sourceOrgId - Source SpaceCat organization id.
 * @param {string} destOrgId - Destination SpaceCat organization id.
 * @returns {Promise<object>} The preview payload.
 */
export async function previewOrgMove(context, sourceOrgId, destOrgId) {
  const postgrestClient = resolvePostgrestClient(context);

  const { data, error } = await postgrestClient.rpc(PREVIEW_RPC, {
    p_src: sourceOrgId,
    p_dst: destOrgId,
  });

  if (error) {
    throw new Error(`${PREVIEW_RPC}: ${error.message}`);
  }

  const preview = unwrap(data);
  if (!preview) {
    throw new Error(`${PREVIEW_RPC} returned no data.`);
  }
  return preview;
}

/**
 * Performs the move. All fourteen tables are rewritten inside one transaction, so this
 * either fully succeeds or fully rolls back.
 *
 * Raises (surfacing as a thrown error) when a blocking conflict is present, so callers
 * should preview first to give the operator a readable message instead of a raw
 * database error.
 *
 * @param {object} context - Lambda context.
 * @param {string} sourceOrgId - Source SpaceCat organization id.
 * @param {string} destOrgId - Destination SpaceCat organization id.
 * @param {string} updatedBy - Audit stamp written to `updated_by`.
 * @returns {Promise<object>} The move result payload.
 */
export async function executeOrgMove(context, sourceOrgId, destOrgId, updatedBy) {
  const postgrestClient = resolvePostgrestClient(context);

  const { data, error } = await postgrestClient.rpc(MOVE_RPC, {
    p_src: sourceOrgId,
    p_dst: destOrgId,
    p_updated_by: updatedBy,
  });

  if (error) {
    throw new Error(`${MOVE_RPC}: ${error.message}`);
  }

  const result = unwrap(data);
  if (!result) {
    throw new Error(`${MOVE_RPC} returned no data.`);
  }
  return result;
}

/**
 * @param {object} preview - Payload from {@link previewOrgMove}.
 * @returns {boolean} True when the preview reports an unusually large move.
 */
export function isLargeMove(preview) {
  const siteCount = preview?.sites?.length || 0;
  const activeBrandCount = (preview?.brands || []).filter((b) => b.status === 'active').length;
  return siteCount > LARGE_MOVE_SITE_THRESHOLD
    || activeBrandCount > LARGE_MOVE_BRAND_THRESHOLD;
}

/**
 * Turns a preview's `error` code into an operator-readable sentence.
 *
 * @param {object} preview - Payload from {@link previewOrgMove}.
 * @returns {string|null} The message, or null when the preview was evaluable.
 */
export function describePreviewError(preview) {
  switch (preview?.error) {
    case 'source_org_not_found':
      return ':x: The site\'s current organization no longer exists.';
    case 'destination_org_not_found':
      return ':x: The destination organization could not be found.';
    case 'same_org':
      return ':information_source: The site is already in that organization - nothing to move.';
    default:
      return preview?.error ? `:x: Cannot evaluate the move: \`${preview.error}\`.` : null;
  }
}

function formatOrg(org) {
  if (!org) {
    return '_unknown_';
  }
  const name = org.name || '_unnamed_';
  return org.ims_org_id ? `*${name}* (\`${org.ims_org_id}\`)` : `*${name}*`;
}

function formatCounts(counts = {}) {
  const lines = COUNT_LABELS
    .filter(([key]) => Number(counts[key]) > 0)
    .map(([key, label]) => `• ${label}: *${counts[key]}*`);
  return lines.length > 0 ? lines.join('\n') : '_Nothing to move._';
}

function formatBrands(brands = []) {
  if (brands.length === 0) {
    return '_No brands._';
  }
  return brands
    .map((b) => `• *${b.name}* (\`${b.status}\`)${b.site_id ? '' : ' — _no site_'}`)
    .join('\n');
}

function formatSites(sites = []) {
  if (sites.length === 0) {
    return '_No sites._';
  }
  return sites.map((s) => `• \`${s.base_url}\``).join('\n');
}

function formatAutoResolved(autoResolved = {}) {
  const notes = [];
  if (autoResolved.categories_merged > 0) {
    notes.push(`• *${autoResolved.categories_merged}* categor${autoResolved.categories_merged === 1 ? 'y' : 'ies'} already exist in the destination and will be *merged* (their prompts are re-pointed at the destination's copy).`);
  }
  if (autoResolved.topics_disambiguated > 0) {
    notes.push(`• *${autoResolved.topics_disambiguated}* topic id${autoResolved.topics_disambiguated === 1 ? '' : 's'} clash with the destination and will be *renamed* with a \` (moved)\` suffix.`);
  }
  if (autoResolved.feature_flags_dropped > 0) {
    notes.push(`• *${autoResolved.feature_flags_dropped}* duplicate feature flag${autoResolved.feature_flags_dropped === 1 ? '' : 's'} will be *dropped* — the destination org's existing value wins.`);
  }
  return notes;
}

/**
 * Renders the blocking conflicts a preview reported.
 *
 * `blocking_conflicts` entries are `{ type, detail }` objects, not strings.
 *
 * @param {Array<object>} conflicts - The `blocking_conflicts` array.
 * @returns {string} Markdown lines.
 */
export function formatBlockingConflicts(conflicts = []) {
  return conflicts
    .map((c) => {
      const label = BLOCKING_CONFLICT_LABELS[c.type] || c.type;
      return `• ${label}: \`${c.detail}\``;
    })
    .join('\n');
}

/**
 * Builds the human-readable preview summary posted before the operator confirms.
 *
 * @param {object} preview - Payload from {@link previewOrgMove}.
 * @param {string} baseURL - The site the operator asked about.
 * @returns {string} Slack mrkdwn.
 */
export function buildPreviewMessage(preview, baseURL) {
  const sections = [
    '*Move LLMO organization*',
    '',
    `Triggered by site: \`${baseURL}\``,
    `From: ${formatOrg(preview.source)}`,
    `To: ${formatOrg(preview.destination)}`,
    '',
    '*What will move*',
    formatCounts(preview.counts),
    '',
    '*Brands*',
    formatBrands(preview.brands),
    '',
    '*Sites*',
    formatSites(preview.sites),
  ];

  const autoResolved = formatAutoResolved(preview.auto_resolved);
  if (autoResolved.length > 0) {
    sections.push('', '*Automatically resolved conflicts*', ...autoResolved);
  }

  if (isLargeMove(preview)) {
    sections.push(
      '',
      `:rotating_light: *This is an unusually large move* (${preview.sites?.length || 0} sites, `
      + `${(preview.brands || []).filter((b) => b.status === 'active').length} active brands). `
      + 'Confirm this is really the customer you meant to relocate before continuing.',
    );
  }

  sections.push('', ENTITLEMENT_GOTCHA);

  return sections.join('\n');
}

/**
 * Builds the summary posted after a successful move.
 *
 * @param {object} result - Payload from {@link executeOrgMove}.
 * @param {string} baseURL - The site the operator asked about.
 * @returns {string} Slack mrkdwn.
 */
export function buildResultMessage(result, baseURL) {
  const lines = [
    `:white_check_mark: *Moved LLMO organization for* \`${baseURL}\``,
    '',
    `From: ${formatOrg(result.source)}`,
    `To: ${formatOrg(result.destination)}`,
    '',
    `• Brands moved: *${result.brands_moved || 0}*`,
    `• Feature flags moved: *${result.feature_flags_moved || 0}*`,
  ];

  if (result.categories_merged > 0) {
    lines.push(`• Categories merged into existing destination rows: *${result.categories_merged}*`);
  }
  if (result.topics_disambiguated > 0) {
    lines.push(`• Topics renamed to avoid a clash: *${result.topics_disambiguated}*`);
  }
  if (result.feature_flags_dropped > 0) {
    lines.push(`• Duplicate feature flags dropped: *${result.feature_flags_dropped}*`);
  }

  lines.push('', ENTITLEMENT_GOTCHA);

  return lines.join('\n');
}
