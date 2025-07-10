/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */
import { expect } from 'chai';
import { QueryRegistry } from '../../../src/controllers/paid/query-registry.js';

describe('Paid RenderQuery (query templating)', () => {
  const queryRegistry = new QueryRegistry();

  it('renders query with all params', async () => {
    const params = {
      siteKey: 'site',
      year: 2024,
      month: 6,
      week: 23,
      groupBy: 'type,channel',
      dimensionColumns: 'type,channel',
      dimensionColumnsPrefixed: 'a.type, a.channel, ',
      tableName: 'db.table',
    };
    const rendered = await queryRegistry.renderQuery(params);
    expect(rendered).to.not.include('{{');
    expect(rendered).to.not.include('}}');
  });

  it('renders query with empty groupBy', async () => {
    const params = {
      siteKey: 'site',
      year: 2024,
      month: 6,
      week: 23,
      groupBy: '',
      dimensionColumns: '',
      dimensionColumnsPrefixed: '',
      tableName: 'db.table',
    };
    const rendered = await queryRegistry.renderQuery(params);
    expect(rendered).to.not.include('{{');
    expect(rendered).to.not.include('}}');
  });
});
