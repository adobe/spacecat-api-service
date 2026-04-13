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
import { AgenticTrafficGlobalDto } from '../../src/dto/agentic-traffic-global.js';

describe('AgenticTrafficGlobalDto', () => {
  it('maps snake_case row to JSON', () => {
    const json = AgenticTrafficGlobalDto.toJSON({
      id: 'uuid',
      year: 2026,
      week: 14,
      hits: 12345,
      created_at: 'c',
      updated_at: 'u',
      updated_by: 'ims-123',
    });

    expect(json).to.deep.equal({
      id: 'uuid',
      year: 2026,
      week: 14,
      hits: 12345,
      createdAt: 'c',
      updatedAt: 'u',
      updatedBy: 'ims-123',
    });
  });

  it('maps null updated_by to null', () => {
    const json = AgenticTrafficGlobalDto.toJSON({
      id: 'uuid',
      year: 2026,
      week: 15,
      hits: 0,
      created_at: 'c',
      updated_at: 'u',
      updated_by: null,
    });

    expect(json.updatedBy).to.be.null;
  });
});
