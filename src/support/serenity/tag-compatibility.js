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

// @ts-check

import { DIMENSION } from './prompt-tags.js';

/**
 * Decorates tag rows with one shared compatibility decision. `items` must be
 * the complete sibling context for an endpoint whenever ambiguous paths matter.
 *
 * @param {Array<any>} items
 * @returns {Array<any>}
 */
export function classifyTagCompatibility(items) {
  const counts = new Map();
  const pathOf = (item) => item.fullPath
    ?? [...(item.path ?? []), { id: item.id ?? '', name: item.name }];
  for (const item of items) {
    const key = pathOf(item).map((part) => String(part.name).normalize('NFKC')
      .toLowerCase()).join('__');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return items.map((item) => {
    const path = pathOf(item);
    const rootName = path[0]?.name ?? item.name;
    const key = path.map((part) => String(part.name).normalize('NFKC')
      .toLowerCase()).join('__');
    let reason = null;
    if (rootName.toLowerCase() === DIMENSION.TAG && rootName !== DIMENSION.TAG) {
      reason = 'caseVariantRoot';
    } else if (path.some((part) => String(part.name).includes(':') || String(part.name).includes('__'))) {
      reason = 'separatorInName';
    } else if (rootName === DIMENSION.TAG && path.length > 3) {
      reason = 'unsupportedDepth';
    } else if ((counts.get(key) ?? 0) > 1) {
      reason = 'ambiguousPath';
    }
    return { ...item, compatibility: { state: reason ? 'readOnly' : 'canonical', reason } };
  });
}
