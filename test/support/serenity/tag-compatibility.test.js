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

import { expect } from 'chai';
import { classifyTagCompatibility } from '../../../src/support/serenity/tag-compatibility.js';

describe('tag compatibility classification', () => {
  it('marks duplicate sibling paths read-only consistently', () => {
    const items = classifyTagCompatibility([
      {
        id: 'one',
        name: 'Leaf',
        fullPath: [{ id: 'tag', name: 'tag' }, { id: 'family', name: 'Family' }, { id: 'one', name: 'Leaf' }],
      },
      {
        id: 'two',
        name: 'Leaf',
        fullPath: [{ id: 'tag', name: 'tag' }, { id: 'family', name: 'Family' }, { id: 'two', name: 'Leaf' }],
      },
    ]);
    expect(items.map((item) => item.compatibility))
      .to.deep.equal([
        { state: 'readOnly', reason: 'ambiguousPath' },
        { state: 'readOnly', reason: 'ambiguousPath' },
      ]);
  });
});
