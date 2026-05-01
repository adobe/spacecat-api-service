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
 * Single source of truth for capability strings shared between
 * `routes/required-capabilities.js` (Layer 1, s2sAuthWrapper) and the controller-level
 * `hasS2SCapability` checks (Layer 2). Both layers must use the same string for the same
 * route — drift is caught by `test/routes/capability-constants.test.js`.
 *
 * See `docs/s2s/READALL_CAPABILITY_DESIGN.md` for the design.
 */

export const CAP_SITE_READ_ALL = 'site:readAll';
export const CAP_ORG_READ_ALL = 'organization:readAll';
