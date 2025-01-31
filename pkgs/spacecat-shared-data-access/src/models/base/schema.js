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

import { hasText, isNonEmptyArray, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { SchemaError, SchemaValidationError } from '../../errors/index.js';
import {
  classExtends,
  entityNameToCollectionName,
  entityNameToIdName,
  isPositiveInteger,
  keyNamesToMethodName,
  modelNameToEntityName,
} from '../../util/util.js';

import BaseCollection from './base.collection.js';
import BaseModel from './base.model.js';
import Reference from './reference.js';

class Schema {
  static INDEX_TYPES = {
    PRIMARY: 'primary',
    ALL: 'all',
    BELONGS_TO: 'belongs_to',
    OTHER: 'other',
  };

  /**
   * Constructs a new Schema instance.
   * @constructor
   * @param {BaseModel} modelClass - The class representing the model.
   * @param {BaseCollection} collectionClass - The class representing the model collection.
   * @param {object} rawSchema - The raw schema data.
   * @param {string} rawSchema.serviceName - The name of the service.
   * @param {number} rawSchema.schemaVersion - The version of the schema.
   * @param {object} rawSchema.attributes - The attributes of the schema.
   * @param {object} rawSchema.indexes - The indexes of the schema.
   * @param {object} rawSchema.options - The options of the schema.
   * @param {Reference[]} [rawSchema.references] - The references of the schema.
   */
  constructor(
    modelClass,
    collectionClass,
    rawSchema,
  ) {
    this.modelClass = modelClass;
    this.collectionClass = collectionClass;

    this.serviceName = rawSchema.serviceName;
    this.schemaVersion = rawSchema.schemaVersion;
    this.attributes = rawSchema.attributes;
    this.indexes = rawSchema.indexes;
    this.options = rawSchema.options;
    this.references = rawSchema.references || [];

    this.#validateSchema();
  }

  #validateSchema() {
    if (!classExtends(this.modelClass, BaseModel)) {
      throw new SchemaValidationError('Model class must extend BaseModel');
    }

    if (!classExtends(this.collectionClass, BaseCollection)) {
      throw new SchemaValidationError('Collection class must extend BaseCollection');
    }

    if (!hasText(this.serviceName)) {
      throw new SchemaValidationError('Schema must have a service name');
    }

    if (!isPositiveInteger(this.schemaVersion)) {
      throw new SchemaValidationError('Schema version must be a positive integer');
    }

    if (!isNonEmptyObject(this.attributes)) {
      throw new SchemaValidationError('Schema must have attributes');
    }

    if (!isNonEmptyObject(this.indexes)) {
      throw new SchemaValidationError('Schema must have indexes');
    }

    if (!Array.isArray(this.references)) {
      throw new SchemaValidationError('References must be an array');
    }

    if (!isNonEmptyObject(this.options)) {
      throw new SchemaValidationError('Schema must have options');
    }
  }

  allowsRemove() {
    return this.options?.allowRemove;
  }

  allowsUpdates() {
    return this.options?.allowUpdates;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  getAttributes() {
    return this.attributes;
  }

  getCollectionName() {
    return this.collectionClass.name;
  }

  getEntityName() {
    return modelNameToEntityName(this.getModelName());
  }

  getIdName() {
    return entityNameToIdName(this.getModelName());
  }

  /**
   * Returns a data structure describing all index-based accessors (like allByX, findByX).
   * This can then be used by BaseCollection to create methods without duplicating logic.
   * @return {Array<{indexName: string, keySets: string[][]}>}
   *   Example: [
   *     { indexName: 'byOpportunityId', keySets: [['opportunityId'], ['opportunityId','status']] },
   *     { indexName: 'byStatusAndCreatedAt', keySets: [['status'],['status','createdAt']] }
   *   ]
   */
  getIndexAccessors() {
    const indexes = this.getIndexes([Schema.INDEX_TYPES.PRIMARY]);
    const result = [];

    Object.keys(indexes).forEach((indexName) => {
      const indexKeys = this.getIndexKeys(indexName);

      if (!isNonEmptyArray(indexKeys)) return;

      const keySets = [];
      for (let i = 1; i <= indexKeys.length; i += 1) {
        keySets.push(indexKeys.slice(0, i));
      }

      result.push({ indexName, keySets });
    });

    return result;
  }

  getIndexByName(indexName) {
    return this.indexes[indexName];
  }

  findIndexBySortKeys(sortKeys) {
    // find index that has same sort keys, then remove the last sort key
    // and find the index that has the remaining sort keys, etc.
    for (let { length } = sortKeys; length > 0; length -= 1) {
      const subKeyNames = sortKeys.slice(0, length);
      const index = Object.values(this.indexes).find((candidate) => {
        const { pk, sk } = candidate;
        const allKeys = [...(pk?.facets || []), ...(sk?.facets || [])];

        // check if all keys in the index are in the sort keys
        return subKeyNames.every((key) => allKeys.includes(key));
      });

      if (isNonEmptyObject(index)) {
        return index;
      }
    }

    return null;
  }

  /**
   * Finds the index name by the keys provided. The index is searched
   * keys to match the combination of partition and sort keys. If no
   * index is found, we fall back to the "all" index, then the "primary".
   *
   * @param {Object} keys - The keys to search for.
   * @return {string} - The index name.
   */
  findIndexNameByKeys(keys) {
    const { ALL, PRIMARY } = this.getIndexTypes();
    const keyNames = Object.keys(keys);

    const index = this.findIndexBySortKeys(keyNames);
    if (index) {
      return index.index || PRIMARY;
    }

    const allIndex = this.findIndexByType(ALL);
    if (allIndex) {
      return allIndex.index;
    }

    return PRIMARY;
  }

  // eslint-disable-next-line class-methods-use-this
  getIndexTypes() {
    return Schema.INDEX_TYPES;
  }

  findIndexByType(type) {
    return Object.values(this.indexes).find((index) => index.indexType === type) || null;
  }

  /**
   * Returns the indexes for the schema. By default, this returns all indexes.
   * You can use the `exclude` parameter to exclude certain indexes.
   * @param {Array<string>} [exclude] - One of the INDEX_TYPES values.
   * @return {object} The indexes.
   */
  getIndexes(exclude) {
    if (!Array.isArray(exclude)) {
      return this.indexes;
    }

    return Object.keys(this.indexes).reduce((acc, indexName) => {
      const index = this.indexes[indexName];

      if (!exclude.includes(indexName)) {
        acc[indexName] = index;
      }

      return acc;
    }, {});
  }

  getIndexKeys(indexName) {
    const index = this.getIndexByName(indexName);

    if (!isNonEmptyObject(index)) {
      return [];
    }

    const pkKeys = Array.isArray(index.pk?.facets) ? index.pk.facets : [];
    const skKeys = Array.isArray(index.sk?.facets) ? index.sk.facets : [];

    return [...pkKeys, ...skKeys];
  }

  getModelClass() {
    return this.modelClass;
  }

  getModelName() {
    return this.modelClass.name;
  }

  /**
   * Given a type and a target model name, returns the reciprocal reference if it exists.
   * For example, if we have a has_many reference from Foo to Bar, this method can help find
   * the belongs_to reference in Bar that points back to Foo.
   * @param {EntityRegistry} registry - The entity registry.
   * @param {Reference} reference - The reference to find the reciprocal for.
   * @return {Reference|null} - The reciprocal reference or null if not found.
   */
  getReciprocalReference(registry, reference) {
    const target = reference.getTarget();
    const type = reference.getType();

    if (type !== Reference.TYPES.HAS_MANY) {
      return null;
    }

    const targetSchema = registry.getCollection(entityNameToCollectionName(target)).schema;

    return targetSchema.getReferenceByTypeAndTarget(
      Reference.TYPES.BELONGS_TO,
      this.getModelName(),
    );
  }

  getReferences() {
    return this.references;
  }

  getReferencesByType(type) {
    return this.references.filter((ref) => ref.type === type);
  }

  getReferenceByTypeAndTarget(type, target) {
    return this.references.find((ref) => ref.type === type && ref.target === target);
  }

  getServiceName() {
    return this.serviceName;
  }

  getVersion() {
    return this.schemaVersion;
  }

  /**
   * Given an entity, generates accessor configurations for all index-based accessors.
   * This is useful for creating methods on the entity that can be used to fetch data
   * based on the index keys. For example, if we have an index by 'opportunityId' and 'status',
   * this method will generate accessor configurations like allByOpportunityId,
   * findByOpportunityId, etc. The accessor configurations can then be used to create
   * accessor methods on the entity using the createAccessors (accessor utils) method.
   *
   * @param {BaseModel|BaseCollection} entity - The entity for which to generate accessors.
   * @param {Object} [log] - The logger to use for logging information
   * @throws {SchemaError} - Throws an error if the entity is not a BaseModel or BaseCollection.
   * @return {Object[]}
   */
  toAccessorConfigs(entity, log = console) {
    if (!(entity instanceof BaseModel) && !(entity instanceof BaseCollection)) {
      throw new SchemaError(this, 'Entity must extend BaseModel or BaseCollection');
    }

    const indexAccessors = this.getIndexAccessors();
    const accessorConfigs = [];

    indexAccessors.forEach(({ indexName, keySets }) => {
      // generate a method for each prefix of the keySets array
      // for example, if keySets = ['opportunityId', 'status'], we create:
      //   allByOpportunityId(...)
      //   findByOpportunityId(...)
      //   allByOpportunityIdAndStatus(...)
      //   findByOpportunityIdAndStatus(...)
      keySets.forEach((subset) => {
        accessorConfigs.push({
          context: entity,
          collection: entity,
          name: keyNamesToMethodName(subset, 'allBy'),
          requiredKeys: subset,
          all: true,
        });

        accessorConfigs.push({
          context: entity,
          collection: entity,
          name: keyNamesToMethodName(subset, 'findBy'),
          requiredKeys: subset,
        });

        log.debug(`Created accessors for index [${indexName}] with keys [${subset.join(', ')}]`);
      });
    });

    return accessorConfigs;
  }

  /**
   * Transforms the stored schema model into a format directly usable by ElectroDB.
   * Here, you could do any final adjustments or transformations needed before returning.
   *
   * @returns {object} ElectroDB-compatible schema.
   */
  toElectroDBSchema() {
    return {
      model: {
        entity: this.getModelName(),
        version: String(this.getVersion()),
        service: this.getServiceName(),
      },
      attributes: this.attributes,
      indexes: this.indexes,
    };
  }
}

export default Schema;
