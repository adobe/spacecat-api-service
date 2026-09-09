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
 * Dependency-free audit-scope predicates.
 *
 * These live in their own leaf module (rather than in the `support/utils.js` hub) so that
 * low-level modules such as `utils/slack/base.js` can import them without pulling in the hub —
 * which would create an import cycle once the hub imports slack helpers (SITES-50179). Keep this
 * file free of any repo imports so it stays a true leaf.
 */

/**
 * Checks if the url parameter "url" equals "ALL".
 * @param {string} url - URL parameter.
 * @returns {boolean} True if url equals "ALL", false otherwise.
 */
export const isAuditForAllUrls = (url) => url.toUpperCase() === 'ALL';

/**
 * Checks if the deliveryType parameter "deliveryType" equals "ALL".
 * @param {string} deliveryType - deliveryType parameter.
 * @returns {boolean} True if deliveryType equals "ALL", false otherwise.
 */
export const isAuditForAllDeliveryTypes = (deliveryType) => deliveryType.toUpperCase() === 'ALL';
