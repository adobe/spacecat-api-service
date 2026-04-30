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
 * Shared constants for the PLG onboarding flow. Imported by every module that
 * participates in PLG onboarding so any change here propagates everywhere and
 * the constants cannot silently drift between call sites.
 */

/**
 * Opportunity types that participate in the PLG auto-fix lifecycle.
 *
 * Used by:
 *   - `plg-onboarding.js` displacement check (`hasActiveSuggestions`) — decides
 *     whether an already-onboarded site still has active customer work.
 *   - `plg-onboarding-cleanup.js` — scopes the pre-ONBOARDED status reset and
 *     FixEntity deletion to only these types.
 *
 * Must also stay in sync with `LD_AUTO_FIX_FLAGS` in `plg-onboarding.js`, which
 * enables LaunchDarkly auto-fix for these same types. Adding a new opportunity
 * type to the PLG auto-fix lifecycle requires updating both this list and the
 * LD flag list together.
 */
export const PLG_OPPORTUNITY_TYPES = ['cwv', 'alt-text', 'broken-backlinks'];
