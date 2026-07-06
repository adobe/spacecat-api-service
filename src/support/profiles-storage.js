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
 * Storage helpers for the `profiles` table (PostgREST). Mirrors the pattern in
 * feature-flags-storage.js. The table is defined by the mysticat-data-service
 * migration 20260706051609_profiles.sql.
 */

const TABLE = 'profiles';

/**
 * Maps a DB row (snake_case) to the API/UI shape (camelCase).
 * @param {object} row
 * @returns {object}
 */
export function rowToProfile(row) {
  return {
    profileId: row.id,
    siteId: row.site_id,
    name: row.name,
    rationale: row.rationale,
    components: row.components ?? [],
    opportunityIds: row.opportunity_ids ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a new profile row.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.name
 * @param {string} params.rationale
 * @param {Array} params.components
 * @param {string[]} params.opportunityIds
 * @returns {Promise<object>} the created profile (API shape)
 */
export async function createProfile({
  postgrestClient, siteId, name, rationale, components, opportunityIds,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for profiles');
  }

  const row = {
    site_id: siteId,
    name,
    rationale,
    components,
    opportunity_ids: opportunityIds,
  };

  const { data, error } = await postgrestClient
    .from(TABLE)
    .insert(row)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create profile: ${error.message}`);
  }

  return rowToProfile(data);
}

/**
 * Updates a profile's mutable fields (name, rationale, components,
 * opportunityIds), scoped to a site. Only provided fields are changed.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.profileId
 * @param {object} params.patch camelCase fields to update
 * @returns {Promise<object|null>} the updated profile (API shape) or null if not found
 */
export async function updateProfile({
  postgrestClient, siteId, profileId, patch,
}) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for profiles');
  }

  const row = {};
  if (patch.name !== undefined) {
    row.name = patch.name;
  }
  if (patch.rationale !== undefined) {
    row.rationale = patch.rationale;
  }
  if (patch.components !== undefined) {
    row.components = patch.components;
  }
  if (patch.opportunityIds !== undefined) {
    row.opportunity_ids = patch.opportunityIds;
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .update(row)
    .eq('id', profileId)
    .eq('site_id', siteId)
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to update profile: ${error.message}`);
  }

  return data ? rowToProfile(data) : null;
}

/**
 * Fetches a single profile by id, scoped to a site.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.profileId
 * @returns {Promise<object|null>} the profile (API shape) or null if not found
 */
export async function getProfileById({ postgrestClient, siteId, profileId }) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for profiles');
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .select('*')
    .eq('id', profileId)
    .eq('site_id', siteId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch profile: ${error.message}`);
  }

  return data ? rowToProfile(data) : null;
}

/**
 * Deletes a profile by id, scoped to a site.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @param {string} params.profileId
 * @returns {Promise<void>}
 */
export async function deleteProfile({ postgrestClient, siteId, profileId }) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for profiles');
  }

  const { error } = await postgrestClient
    .from(TABLE)
    .delete()
    .eq('id', profileId)
    .eq('site_id', siteId);

  if (error) {
    throw new Error(`Failed to delete profile: ${error.message}`);
  }
}

/**
 * Lists all profiles for a site, newest first.
 * @param {object} params
 * @param {object} params.postgrestClient
 * @param {string} params.siteId
 * @returns {Promise<object[]>} profiles (API shape)
 */
export async function listProfilesBySite({ postgrestClient, siteId }) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for profiles');
  }

  const { data, error } = await postgrestClient
    .from(TABLE)
    .select('*')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list profiles: ${error.message}`);
  }

  return (data ?? []).map(rowToProfile);
}
