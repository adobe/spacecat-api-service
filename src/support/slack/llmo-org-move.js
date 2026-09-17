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
 * Shared logic for relocating a customer's LLMO ("brandalf") entity graph from one
 * organization to another.
 *
 * Historically the Slack "Update IMS Org" flow only reassigned `sites.organization_id`,
 * which stranded every brand-centric entity (brands, prompts, topics, categories,
 * competitors, feature flags) in the source org. Now that the product navigates by
 * brand rather than by site, that left customers with an empty destination org and an
 * orphaned source org (LLMO-7294).
 *
 * The move is scoped to a SITE, not to an organization. Customers are routinely
 * provisioned into a shared or DEMO org, so relocating everything matching
 * `organization_id = <source>` would drag every other tenant in that org along too. The
 * database resolves the transitive closure of brands and sites reachable from the given
 * site instead - a site can carry many brands and a brand can span many sites, so the
 * closure is frequently wider than the one site the operator names, and the preview
 * spells out exactly what it pulled in.
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
 * risk - but a closure this wide is a strong hint the operator named a site that shares
 * brands with an unrelated customer, and is about to relocate both.
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
 * source org's now-unused entitlement in place.
 *
 * The ordering below is not advisory. `revoke entitlement site` deletes the enrollment
 * for a site regardless of which org it currently belongs to, so running it *after* a
 * move deletes the correct enrollment this command just created, silently leaving the
 * customer without access in the destination org.
 */
export const ENTITLEMENT_GOTCHA = ':warning: *Entitlements are not moved* — and the order '
  + 'you clean them up in matters.\n'
  + '• *Moving a whole tenant between IMS orgs:* run `revoke entitlement imsorg` against '
  + 'the *source* IMS org *after* this move completes.\n'
  + '• *Extracting a customer from a shared/DEMO org:* run `revoke entitlement site` '
  + '*before* this move. Running it afterwards deletes the enrollment this command just '
  + 'created on the destination org and leaves the customer with no access.\n'
  + '• Neither command removes a `site_enrollments` row backed by a *paid* entitlement — '
  + 'that still needs doing by hand.';

/**
 * Tables reported by the preview, in the order they are rendered. Keys match the
 * `counts` object returned by `rpc_org_move_preview`.
 *
 * Categories and topics are absent by design: they are copied into the destination
 * rather than moved, and are reported separately under the taxonomy plan. The two
 * prompt junction tables are absent too - they follow their prompts automatically via
 * the `sync_prompt_junction_tables` trigger.
 */
const COUNT_LABELS = [
  ['brands', 'Brands'],
  ['sites', 'Sites'],
  ['prompts', 'Prompts'],
  ['brand_aliases', 'Brand aliases'],
  ['brand_sites', 'Brand ↔ site links'],
  ['brand_urls', 'Brand URLs'],
  ['brand_social_accounts', 'Social accounts'],
  ['brand_earned_sources', 'Earned sources'],
  ['competitors', 'Competitors'],
  ['brand_feature_flags', 'Brand feature flags'],
];

const BLOCKING_CONFLICT_LABELS = {
  brand_name: 'A brand with this name already exists in the destination org',
  brand_base_site: 'A brand in the destination org already uses this site',
  foreign_brand_in_scope: 'This brand is reachable from the site but belongs to a different org '
    + '(pre-existing cross-org data; moving would drag an unrelated tenant along)',
  foreign_site_in_scope: 'This site is reachable from the site but belongs to a different org '
    + '(pre-existing cross-org data; moving would drag an unrelated tenant along)',
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
 * Reports what moving the closure rooted at `siteId` into `destOrgId` would do.
 * Read-only.
 *
 * Never throws on a business-level problem: an unevaluable request (unknown site or org,
 * site already in the destination) comes back as `{ ok: false, error: <code> }`, and a
 * genuine blocking conflict comes back as `{ ok: false, blocking_conflicts: [...] }`
 * with no `error` key. Only transport/database failures throw.
 *
 * @param {object} context - Lambda context.
 * @param {string} siteId - The site the move is seeded from.
 * @param {string} destOrgId - Destination SpaceCat organization id.
 * @returns {Promise<object>} The preview payload.
 */
export async function previewOrgMove(context, siteId, destOrgId) {
  const postgrestClient = resolvePostgrestClient(context);

  const { data, error } = await postgrestClient.rpc(PREVIEW_RPC, {
    p_site_id: siteId,
    p_dst_org: destOrgId,
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
 * Performs the move. Every affected table is rewritten inside one transaction, so this
 * either fully succeeds or fully rolls back.
 *
 * Raises (surfacing as a thrown error) when a blocking conflict is present, so callers
 * should preview first to give the operator a readable message instead of a raw
 * database error.
 *
 * @param {object} context - Lambda context.
 * @param {string} siteId - The site the move is seeded from.
 * @param {string} destOrgId - Destination SpaceCat organization id.
 * @param {string} updatedBy - Audit stamp written to `updated_by`.
 * @returns {Promise<object>} The move result payload.
 */
export async function executeOrgMove(context, siteId, destOrgId, updatedBy) {
  const postgrestClient = resolvePostgrestClient(context);

  const { data, error } = await postgrestClient.rpc(MOVE_RPC, {
    p_site_id: siteId,
    p_dst_org: destOrgId,
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
    case 'site_not_found':
      return ':x: That site no longer exists.';
    case 'site_and_destination_required':
      return ':x: A site and a destination organization are both required.';
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
  return sites
    .map((s) => `• \`${s.base_url}\`${s.is_seed ? ' ← _the site you named_' : ''}`)
    .join('\n');
}

/**
 * Describes what happens to the shared taxonomy.
 *
 * Categories and topics are copied into the destination rather than moved, because both
 * are shared across brands: `categories` has no `brand_id` at all, and brand-owned
 * topics are routinely referenced by other brands' prompts. Moving those rows would
 * strip the taxonomy from whichever brands stay behind.
 *
 * @param {object} taxonomy - The preview's `taxonomy` object.
 * @returns {Array<string>} Markdown lines.
 */
function formatTaxonomyPlan(taxonomy = {}) {
  const notes = [];
  const reused = (taxonomy.categories_reused || 0) + (taxonomy.topics_reused || 0);
  const copied = (taxonomy.categories_copied || 0) + (taxonomy.topics_copied || 0);

  if (copied > 0) {
    notes.push(
      `• *${taxonomy.categories_copied || 0}* categor${taxonomy.categories_copied === 1 ? 'y' : 'ies'} `
      + `and *${taxonomy.topics_copied || 0}* topic${taxonomy.topics_copied === 1 ? '' : 's'} `
      + 'will be *copied* into the destination org.',
    );
  }
  if (reused > 0) {
    notes.push(
      `• *${taxonomy.categories_reused || 0}* categor${taxonomy.categories_reused === 1 ? 'y' : 'ies'} `
      + `and *${taxonomy.topics_reused || 0}* topic${taxonomy.topics_reused === 1 ? '' : 's'} `
      + 'already exist in the destination and will be *reused*.',
    );
  }
  if (copied > 0 || reused > 0) {
    notes.push(
      '• The originals stay in the source org — they are shared with brands that are '
      + '_not_ moving, so they are copied rather than relocated.',
    );
  }
  if (taxonomy.org_feature_flags_copied > 0) {
    notes.push(
      `• *${taxonomy.org_feature_flags_copied}* org-level feature flag`
      + `${taxonomy.org_feature_flags_copied === 1 ? '' : 's'} will be *copied* to the `
      + 'destination (existing destination values are never overwritten).',
    );
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
 * The brand and site lists are the point of this message, not decoration: the move is
 * seeded from one site but covers everything transitively connected to it, so the
 * operator has to be able to see whether the closure pulled in more than they meant.
 *
 * @param {object} preview - Payload from {@link previewOrgMove}.
 * @param {string} baseURL - The site the operator asked about.
 * @returns {string} Slack mrkdwn.
 */
export function buildPreviewMessage(preview, baseURL) {
  const brands = preview.brands || [];
  const sites = preview.sites || [];

  const sections = [
    '*Move LLMO organization*',
    '',
    `Seeded from site: \`${baseURL}\``,
    `From: ${formatOrg(preview.source)}`,
    `To: ${formatOrg(preview.destination)}`,
    '',
    `*Everything below moves together* — ${brands.length} brand${brands.length === 1 ? '' : 's'} `
    + `across ${sites.length} site${sites.length === 1 ? '' : 's'}. Brands and sites are linked `
    + 'many-to-many, so relocating one without the others would leave the link rows pointing '
    + 'across an org boundary.',
    '',
    '*What will move*',
    formatCounts(preview.counts),
    '',
    '*Brands*',
    formatBrands(brands),
    '',
    '*Sites*',
    formatSites(sites),
  ];

  const taxonomy = formatTaxonomyPlan(preview.taxonomy);
  if (taxonomy.length > 0) {
    sections.push('', '*Shared taxonomy*', ...taxonomy);
  }

  if (isLargeMove(preview)) {
    sections.push(
      '',
      `:rotating_light: *This is an unusually large move* (${sites.length} sites, `
      + `${brands.filter((b) => b.status === 'active').length} active brands). `
      + 'Check the lists above and confirm this is really the customer you meant to '
      + 'relocate before continuing.',
    );
  }

  sections.push('', ENTITLEMENT_GOTCHA);

  return sections.join('\n');
}

/**
 * Builds the summary posted after a successful move.
 *
 * The org display names come from the preview, not the result: the write RPC returns
 * bare organization ids.
 *
 * @param {object} result - Payload from {@link executeOrgMove}.
 * @param {string} baseURL - The site the operator asked about.
 * @param {object} [preview] - The preview the move was confirmed from, for org names.
 * @returns {string} Slack mrkdwn.
 */
export function buildResultMessage(result, baseURL, preview = {}) {
  const lines = [
    `:white_check_mark: *Moved LLMO organization for* \`${baseURL}\``,
    '',
    `From: ${formatOrg(preview.source)}`,
    `To: ${formatOrg(preview.destination)}`,
    '',
    `• Brands moved: *${result.brands_moved || 0}*`,
    `• Sites moved: *${result.sites_moved || 0}*`,
    `• Prompts moved: *${result.prompts_moved || 0}*`,
  ];

  if (result.brand_feature_flags_moved > 0) {
    lines.push(`• Brand feature flags moved: *${result.brand_feature_flags_moved}*`);
  }
  if (result.org_feature_flags_copied > 0) {
    lines.push(`• Org feature flags copied: *${result.org_feature_flags_copied}*`);
  }
  if (result.categories_mapped > 0) {
    lines.push(`• Categories resolved in the destination: *${result.categories_mapped}*`);
  }
  if (result.topics_mapped > 0) {
    lines.push(`• Topics resolved in the destination: *${result.topics_mapped}*`);
  }
  if (result.source_topics_unowned > 0) {
    lines.push(
      '• Topics left in the source org and released from their moved brand: '
      + `*${result.source_topics_unowned}*`,
    );
  }

  lines.push('', ENTITLEMENT_GOTCHA);

  return lines.join('\n');
}
