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

// SITES-50099: strips the "Serenity prompt delete " label prefix off a logged
// line and parses the embedded JSON payload. Shared by prompts.test.js and
// prompts-subworkspace.test.js, which both exercise the same audit log line.
export const AUDIT_LABEL = 'Serenity prompt delete ';

export function parseAuditLine(line) {
  return JSON.parse(line.slice(AUDIT_LABEL.length));
}
