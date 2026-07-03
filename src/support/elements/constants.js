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

export const DEFAULT_ELEMENT_MODEL = 'search-gpt';

export const ELEMENT_MODELS = Object.freeze([
  'google-ai-mode',
  'grok-3',
  'google-ai-overview',
  'microsoft-copilot',
  'open-evidence',
  'gemini-2.5-flash',
  'claude-sonnet-4',
  'gpt-5',
  'deepseek',
  'search-gpt',
  'perplexity',
]);

/**
 * Maps the UI's platform filter codes (project-elmo-ui `PLATFORM_CODES`) to the
 * Semrush Elements model names in {@link ELEMENT_MODELS}. Vivek/UI confirmed the UI
 * keeps sending its existing platform values, so the translation lives here on the
 * SpaceCat side.
 *
 * Only entries whose names DIFFER are listed. Codes that are already identical to a
 * Semrush model (`google-ai-overview`, `google-ai-mode`, `perplexity`) and any
 * Semrush-only model with no UI counterpart (`grok-3`, `open-evidence`,
 * `claude-sonnet-4`, `deepseek`) need no entry — {@link resolveElementModel} passes
 * them through unchanged.
 *
 * TODO(LLMO-6011): confirm the two ChatGPT tier mappings with product — `openai`
 * (ChatGPT Paid) → `gpt-5` and `chatgpt` (ChatGPT Free) → `search-gpt` are best-guess.
 */
export const PLATFORM_TO_ELEMENT_MODEL = Object.freeze({
  copilot: 'microsoft-copilot',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-5',
  chatgpt: 'search-gpt',
});

/**
 * Resolves a requested platform/model value to a valid Semrush Elements model.
 * Applies the UI→Semrush translation first, then respects any value that is already
 * a valid Semrush model, and finally falls back to {@link DEFAULT_ELEMENT_MODEL}.
 *
 * @param {string} [value] - Raw value from the `model` or `platform` query param.
 * @returns {string} A member of {@link ELEMENT_MODELS}.
 */
export function resolveElementModel(value) {
  const mapped = PLATFORM_TO_ELEMENT_MODEL[value] ?? value;
  return ELEMENT_MODELS.includes(mapped) ? mapped : DEFAULT_ELEMENT_MODEL;
}
