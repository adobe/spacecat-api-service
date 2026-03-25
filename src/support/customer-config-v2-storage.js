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

const TABLE_NAME = 'llmo_customer_config';

/**
 * Reads the V2 customer configuration for an organization from Postgres.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {object} postgrestClient - PostgREST client from dataAccess.services
 * @returns {Promise<object|null>} The config object or null if not found
 * @throws {Error} When PostgREST query fails for reasons other than not found
 */
export async function readCustomerConfigV2FromPostgres(organizationId, postgrestClient) {
  if (!postgrestClient?.from) {
    return null;
  }

  const { data, error } = await postgrestClient
    .from(TABLE_NAME)
    .select('config')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read customer config: ${error.message}`);
  }

  if (!data?.config) {
    return null;
  }

  return data.config;
}

/**
 * Writes the V2 customer configuration for an organization to Postgres.
 * Upserts by organization_id.
 *
 * @param {string} organizationId - SpaceCat organization UUID
 * @param {object} config - The full customer configuration object
 * @param {object} postgrestClient - PostgREST client from dataAccess.services
 * @param {string} [updatedBy] - User who performed the update
 * @returns {Promise<void>}
 * @throws {Error} When PostgREST upsert fails
 */
export async function writeCustomerConfigV2ToPostgres(
  organizationId,
  config,
  postgrestClient,
  updatedBy = 'system',
) {
  if (!postgrestClient?.from) {
    throw new Error('PostgREST client is required for v2 customer config');
  }

  const row = {
    organization_id: organizationId,
    config,
    updated_by: updatedBy,
  };

  const { error } = await postgrestClient
    .from(TABLE_NAME)
    .upsert(row, { onConflict: 'organization_id' });

  if (error) {
    throw new Error(`Failed to write customer config: ${error.message}`);
  }
}
