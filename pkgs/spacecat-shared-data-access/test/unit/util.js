/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { Entity } from 'electrodb';
// eslint-disable-next-line import/no-extraneous-dependencies
import { spy, stub } from 'sinon';

import EntityRegistry from '../../src/models/base/entity.registry.js';
import { modelNameToEntityName } from '../../src/util/util.js';

export const createElectroMocks = (Model, record) => {
  const entityName = modelNameToEntityName(Model.name);
  const {
    schema,
    collection: Collection,
  } = EntityRegistry.entities[modelNameToEntityName(Model.name)];
  const entity = new Entity(schema.toElectroDBSchema());

  const mockLogger = {
    debug: spy(),
    error: spy(),
    info: spy(),
    warn: spy(),
  };

  const mockOperations = {
    create: stub().returns({
      go: stub().resolves({ data: record }),
    }),
    delete: stub().returns({
      go: stub().resolves({}),
    }),
    patch: stub().returns({
      set: stub(),
    }),
    put: stub().returns({
      go: stub().resolves({ data: record }),
    }),
    query: {
      all: stub().returns({
        between: stub().returns({
          go: () => ({ data: [] }),
        }),
        go: () => ({ data: [] }),
      }),
      bySomeKey: stub(),
      primary: stub(),
      byOpportunityId: stub(),
      byOpportunityIdAndStatus: stub(),
      'spacecat-data-gsi1pk-gsi1sk': stub().returns({
        go: () => ({ data: [] }),
      }),
    },
  };

  const mockEntityRegistry = {
    log: mockLogger,
    getCollection: stub().returns({
      schema: {
        getReferenceByTypeAndTarget: stub().returns(null),
        getModelName: stub().returns(Model.name),
        indexes: {
          primaryIndex: {
            pk: { facets: ['testEntityId'] },
            sk: { facets: ['name', 'age'] },
          },
        },
      },
    }),
  };

  const mockElectroService = {
    entities: {
      [entityName]: { ...entity, ...mockOperations },
    },
  };

  const model = new Model(
    mockElectroService,
    mockEntityRegistry,
    schema,
    record,
    mockLogger,
  );

  const collection = new Collection(
    mockElectroService,
    mockEntityRegistry,
    schema,
    mockLogger,
  );

  return {
    mockElectroService,
    mockLogger,
    mockEntityRegistry,
    collection,
    model,
    schema,
  };
};

export async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
