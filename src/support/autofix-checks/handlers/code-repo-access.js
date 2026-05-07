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

const CHECK_TYPE = 'code-repo-access';

const CODE_TYPE = {
  STANDARD: 'standard',
  GITHUB: 'github',
};

const isNumericString = (value) => !!value && /^\d+$/.test(value);

/**
 * Checks whether a site's code repository supports PR creation for code patches.
 *
 * Mirrors the client-side `getCodePatchRestriction` logic in the UI:
 *   - CM Standard (type="standard")       → FAILED (PRs not supported)
 *   - CM BYOG GitHub (type="github" with
 *     numeric owner+repo)                 → FAILED (PR creation coming soon)
 *   - AEMY / GitLab / Bitbucket / Azure   → PASSED
 *   - No code config                      → SKIPPED (not a code-apply site)
 *
 * @param {Object} site - Site entity
 * @returns {{type: string, status: string, message: string}}
 */
export default function codeRepoAccessHandler(site) {
  const code = site.getCode();

  if (!code?.type) {
    return {
      type: CHECK_TYPE,
      status: 'SKIPPED',
      message: 'No code configuration — site does not use code patches',
    };
  }

  if (code.type === CODE_TYPE.STANDARD) {
    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: 'Pull Request creation is not supported on Cloud Manager standard repositories. Please migrate to Cloud Manager BYOG.',
      details: code.url,
    };
  }

  if (code.type === CODE_TYPE.GITHUB && isNumericString(code.owner) && isNumericString(code.repo)) {
    return {
      type: CHECK_TYPE,
      status: 'FAILED',
      message: 'Pull Request creation for Cloud Manager GitHub repositories is coming soon.',
    };
  }

  return {
    type: CHECK_TYPE,
    status: 'PASSED',
    message: 'Code repository supports PR creation',
  };
}
