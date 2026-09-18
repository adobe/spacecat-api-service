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
 * Canonical brand-name normalization (LLMO-7284).
 *
 * Single source of truth shared by the write-time duplicate guard
 * (`src/support/brands-storage.js::assertNoDuplicateActiveBrandName`) and the
 * detection-side reconcile report
 * (`scripts/reconcile-org-identity-integrity.mjs`). Prevention and detection are
 * two ends of the same contract: if the two normalizers ever disagree, the guard
 * starts blocking names the report does not flag (or vice versa). Keeping one
 * definition makes that divergence impossible.
 *
 * Deliberately ASCII case/whitespace folding only (trim, collapse internal
 * whitespace, lowercase). It does NOT apply Unicode NFC/NFKC or full case-folding,
 * so visually-confusable variants (full-width, precomposed vs combining accents,
 * homoglyphs) are not caught here; those are a known, accepted boundary that the
 * after-the-fact reconcile report still surfaces. This module is intentionally
 * dependency-free (no filesystem or sibling reads) so it is safe under the Lambda
 * bundle rules and importable by the standalone reconcile script.
 *
 * @param {string} name
 * @returns {string} the normalized comparison key
 */
export function normalizeBrandName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
