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
 * Shared sanitization + limit for the brand-claims guidance free-text fields
 * (brandContext, mentionSentimentGuidance). Kept in one place so every path that
 * persists guidance — the storage write path (brands-storage.js) and the V1->V2
 * config migration (customer-config-mapper.js) — strips the same characters and
 * agrees on the same length, and so the controller (brands.js) validates against
 * the same limit it is enforcing.
 */

/**
 * The customer-facing "characters" limit for a single guidance field. Measured in
 * Unicode code points (see codePointLength), so one emoji counts as one character.
 */
export const BRAND_GUIDANCE_MAX_LENGTH = 4000;

/*
 * Guidance is persisted verbatim and later interpolated into the Claims-extraction
 * LLM prompt, so we strip characters that carry no legitimate meaning in guidance
 * prose but can corrupt the prompt, downstream logs/terminals, or a bidi-aware
 * renderer:
 *   - C0 control chars except tab/newline/carriage-return (U+0000-U+001F minus \t\n\r)
 *   - DEL and the C1 control block (U+007F-U+009F)
 *   - zero-width / word-joiner / BOM (U+200B-U+200D, U+2060, U+FEFF)
 *   - line/paragraph separators (U+2028, U+2029) — break JSON-embedded-in-JS and forge log lines
 *   - bidirectional override & isolate controls -- the "Trojan Source" class
 *     (U+202A-U+202E, U+2066-U+2069)
 * Ordinary whitespace and all printable Unicode (incl. RTL letters, accents, emoji)
 * are preserved, so this is language-safe. Notably we do NOT strip lone surrogates
 * (U+D800-U+DFFF) here: without the RegExp `u` flag that range also matches each half
 * of a legitimate surrogate pair, which would delete every emoji / astral-plane
 * character. This is defense-in-depth, not a substitute for treating the stored text
 * as untrusted at prompt-assembly time (prompt-injection is owned by the LLM template).
 */
export const UNSAFE_TEXT_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F'
  + '\\u200B-\\u200D\\u2060\\uFEFF\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

/**
 * Strip the unsafe control/invisible/bidi characters above from a string.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeGuidanceText(value) {
  return value.replace(UNSAFE_TEXT_CHARS, '');
}

/**
 * Length of a string in Unicode code points (not UTF-16 code units), so a non-BMP
 * character (emoji, some CJK) counts as one. Both the controller and the storage
 * backstop measure the guidance limit this way so they agree on what "4000
 * characters" means for astral input.
 * @param {string} value
 * @returns {number}
 */
export function codePointLength(value) {
  return [...value].length;
}
