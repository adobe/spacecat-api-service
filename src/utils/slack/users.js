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
 * Resolves a Slack user ID to a display name using the Bolt client.
 * Prefer display_name → real_name → username handle → userId fallback.
 * Used only for human-readable messages; audit fields must use the raw userId.
 *
 * @param {object} client - Bolt Slack client
 * @param {string} userId - Slack user ID (e.g. U12345)
 * @returns {Promise<string>} Display name, or userId if lookup fails
 */
async function resolveSlackUsername(client, userId) {
  if (!client || !userId) return userId;
  try {
    const result = await client.users.info({ user: userId });
    return result.user?.profile?.display_name
      || result.user?.profile?.real_name
      || result.user?.name
      || userId;
  } catch {
    return userId;
  }
}

export default resolveSlackUsername;
