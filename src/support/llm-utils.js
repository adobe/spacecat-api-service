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
 * Small, dependency-free helpers shared by every best-effort LLM caller in this codebase
 * (`intent-classifier.js`, `suggestion-translator.js`, ...). Kept here instead of duplicated
 * per-consumer so the two behaviors below stay consistent across callers.
 */

/**
 * Races a promise against a timer. Rejects with a timeout error if `promise` does not settle
 * within `timeoutMs`. The timer is always cleared so the event loop is not held open by a
 * pending timeout once the race resolves. Note: this only stops the *caller* from waiting any
 * longer — it does not cancel `promise` itself, which keeps running in the background.
 *
 * @param {Promise<*>} promise - Work to bound
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<*>} resolves/rejects with `promise`, or rejects on timeout
 */
export function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Coerces an LLM message `content` into a plain string. Chat-model `.invoke()` responses may
 * return `content` as a string OR as an array of content parts (`[{ type: 'text', text: '...' },
 * ...]`). Array content is concatenated from its text parts so downstream parsing sees the full
 * model output rather than silently failing on a non-string.
 *
 * @param {*} content - `response.content` from the model
 * @returns {string}
 */
export function contentToString(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        // LangChain text parts: { type: 'text', text: '...' }. Some providers use `content`
        // instead of `text`; accept either, ignore non-text parts.
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') {
            return part.text;
          }
          if (typeof part.content === 'string') {
            return part.content;
          }
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}
