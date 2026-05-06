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

export class LockExceptionError extends Error {
  constructor(field) {
    super(`field "${field}" is not in lock-exception allowlist`);
    this.name = 'LockExceptionError';
    this.field = field;
  }
}

export async function saveStrategyWithLockException(
  strategy,
  patch,
  {
    allowedFields, persist, audit, actor,
  },
) {
  const fields = Object.keys(patch);
  for (const f of fields) {
    if (!allowedFields.includes(f)) {
      throw new LockExceptionError(f);
    }
  }
  const merged = { ...strategy, ...patch, updatedAt: new Date().toISOString() };
  await persist(merged);
  await audit({
    action: 'lock-exception-write',
    strategyId: strategy.id,
    fields,
    actor,
  });
  return merged;
}
