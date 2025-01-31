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

import { isNonEmptyArray, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { DataAccessError } from '../../errors/index.js';
import { createAccessors } from '../../util/accessor.utils.js';
import { ensurePermission } from '../../util/auth.js';
import Patcher from '../../util/patcher.js';
import {
  capitalize,
  decapitalize,
  entityNameToIdName,
  idNameToEntityName,
} from '../../util/util.js';

import Reference from './reference.js';

/**
 * Base - A base class for representing individual entities in the application.
 * Provides common functionality for entity management, including fetching, updating,
 * and deleting records. This class is intended to be extended by specific entity classes
 * that represent individual entities in the application. The BaseModel class provides
 * methods for fetching associated entities based on the type of relationship
 * (belongs_to, has_one, has_many).
 * The fetched references are cached to avoid redundant database queries. If the reference
 * is already cached, it will be returned directly.
 * Attribute values can be accessed and modified using getter and setter methods that are
 * automatically generated based on the entity schema. The BaseModel class also provides
 * methods for removing and saving entities to the database.
 *
 * @class BaseModel
 */
class BaseModel {
  /**
   * Constructs an instance of BaseModel.
   * @constructor
   * @param {Object} electroService - The ElectroDB service used for managing entities.
   * @param {EntityRegistry} entityRegistry - The registry holding entities, their schema
   * and collection.
   * @param {Schema} schema - The schema for the entity.
   * @param {Object} record - The initial data for the entity instance.
   * @param {Object} log - A log for capturing logging information.
   */
  constructor(electroService, entityRegistry, schema, record, log, aclCtx) {
    this.electroService = electroService;
    this.entityRegistry = entityRegistry;
    this.schema = schema;
    this.record = record;
    this.log = log;
    this.aclCtx = aclCtx;

    this.entityName = schema.getEntityName();
    this.idName = entityNameToIdName(this.entityName);

    this.collection = entityRegistry.getCollection(schema.getCollectionName());
    this.entity = electroService.entities[this.entityName];

    this.patcher = new Patcher(this.entity, this.schema, this.record);

    this._accessorCache = {};

    this.#initializeReferences();
    this.#initializeAttributes();
  }

  /**
   * Initializes the references for the current entity.
   * This method is called during the construction of the entity instance
   * to set up the reference methods for fetching associated entities.
   * @private
   */
  #initializeReferences() {
    const references = this.schema.getReferences();

    references.forEach((reference) => {
      const accessorConfigs = reference.toAccessorConfigs(this.entityRegistry, this);
      createAccessors(accessorConfigs, this.log);
    });
  }

  /**
   * Provide a path representation of the current instance for ACL purposes.
   * @returns The path representation. Always absolute, so starts with a '/'.
   */
  getACLPath() {
    const refs = this.schema.getReferencesByType(Reference.TYPES.BELONGS_TO);
    if (refs.length !== 1) {
      return `/${this.entityName}/${this.getId()}`;
    }
    const ownerID = this.record[entityNameToIdName(refs[0].target)];
    return `/${decapitalize(refs[0].target)}/${ownerID}/${this.entityName}/${this.getId()}`;
  }

  /**
   * Initializes the attributes for the current entity. This method is called during the
   * construction of the entity instance to set up the getter and setter methods for
   * accessing and modifying the entity attributes. The getter and setter methods are
   * automatically generated based on the entity schema. If the schema allows updates,
   * setter methods are generated for each attribute that is not read-only.
   *
   * If the attribute is a reference, the setter method will tell the patcher
   * to validate that the value is a valid UUID.
   *
   * @private
   */
  #initializeAttributes() {
    const attributes = this.schema.getAttributes();

    if (!isNonEmptyObject(attributes)) {
      return;
    }

    for (const [name, attr] of Object.entries(attributes)) {
      const capitalized = capitalize(name);
      const getterMethodName = `get${capitalized}`;
      const isReference = this.schema
        .getReferencesByType(Reference.TYPES.BELONGS_TO)
        .some((ref) => ref.getTarget() === idNameToEntityName(name));

      if (!this[getterMethodName] || name === this.idName) {
        this[getterMethodName] = () => {
          ensurePermission(this.getACLPath(), this.aclCtx, 'R');
          return this.record[name];
        };
      }

      if (this.schema.allowsUpdates()) {
        const setterMethodName = `set${capitalized}`;

        if (!this[setterMethodName] && !attr.readOnly) {
          this[setterMethodName] = (value) => {
            ensurePermission(this.getACLPath(), this.aclCtx, 'U');
            this.patcher.patchValue(name, value, isReference);
            return this;
          };
        }
      }
    }
  }

  /**
   * Clears the accessor cache for the entity. This method is called when the entity is
   * updated or removed to ensure that the cache is invalidated.
   * @private
   */
  #invalidateCache() {
    this._accessorCache = {};
  }

  /**
   * Fetches the associated entities for the current entity based on the type of relationship.
   * This is used for the remove operation to remove dependent entities associated with the
   * current entity.
   * @return {Promise<Array>}
   * @private
   */
  async #fetchDependents() {
    const promises = [];

    const relationshipTypes = [
      Reference.TYPES.HAS_MANY,
      Reference.TYPES.HAS_ONE,
    ];

    relationshipTypes.forEach((type) => {
      const references = this.schema.getReferencesByType(type);
      const targets = references.filter((reference) => reference.isRemoveDependents());

      targets.forEach((reference) => {
        const accessors = reference.toAccessorConfigs(this.entityRegistry, this);
        const methodName = accessors[0].name;
        promises.push(
          this[methodName]()
            .then((dependent) => {
              if (isNonEmptyArray(dependent)) {
                return dependent;
              } else if (isNonEmptyObject(dependent)) {
                return [dependent];
              }

              return null;
            }),
        );
      });
    });

    const results = await Promise.all(promises);

    return results.flat().filter((dependent) => dependent !== null);
  }

  /**
   * Gets the ID of the current entity.
   * @returns {string} - The unique identifier of the entity.
   */
  getId() {
    return this.record[this.idName];
  }

  /**
   * Gets the creation timestamp of the current entity.
   * @returns {string} - The ISO string representing when the entity was created.
   */
  getCreatedAt() {
    return this.record.createdAt;
  }

  /**
   * Gets the update timestamp of the current entity.
   * @returns {string} - The ISO string representing when the entity was last updated.
   */
  getUpdatedAt() {
    return this.record.updatedAt;
  }

  /**
   * Gets the expiration timestamp of the current entity.
   * @returns {string} - The ISO string representing when the entity will expire.
   */
  getRecordExpiresAt() {
    return this.record.recordExpiresAt;
  }

  /**
   * Removes the current entity from the database. This method also removes any dependent
   * entities associated with the current entity. For example, if the current entity has
   * a has_many relationship with another entity, the dependent entity will be removed.
   * When adding a reference to an entity, the dependent entity will be removed if the
   * removeDependentss flag is set to true in the reference definition.
   *
   * Dependents are removed by calling the remove method on each dependent entity, which in turn
   * will also remove any dependent entities associated with the dependent entity. For dependent
   * entities the allowRemove flag is ignored.
   *
   * Removal of entities with many dependents can be a costly operation, as each dependent entity
   * will be removed individually. This can result in a large number of database operations, which
   * can impact performance. It is recommended to use this method with caution, especially when
   * removing entities with many dependents.
   *
   * @async
   * @returns {Promise<BaseModel>} - A promise that resolves to the current instance of the entity
   * after it and its dependents have been removed.
   * @throws {DataAccessError} - Throws an error if the schema does not allow removal
   * or if the removal operation fails.
   */
  async remove() {
    if (!this.schema.allowsRemove()) {
      throw new DataAccessError(`The entity ${this.schema.getModelName()} does not allow removal`);
    }

    return this._remove();
  }

  /**
   * Internal remove method that removes the current entity from the database and its dependents.
   * This method does not check if the schema allows removal in order to be able to remove
   * dependents even if the schema does not allow removal.
   * @return {Promise<BaseModel>}
   * @throws {DataAccessError} - Throws an error if the removal operation fails.
   * @protected
   */
  async _remove() {
    try {
      const dependents = await this.#fetchDependents();

      const removePromises = dependents.map(async (dependent) => {
        try {
          // eslint-disable-next-line no-underscore-dangle
          await dependent._remove();
        } catch (e) {
          this.log.error(`Failed to remove dependent entity ${dependent.entityName} with ID ${dependent.getId()}`, e);
          throw new DataAccessError(
            `Failed to remove dependent entity ${dependent.entityName} with ID ${dependent.getId()}`,
            dependent,
            e,
          );
        }
      });

      this.log.info(`Removing entity ${this.entityName} with ID ${this.getId()} and ${dependents.length} dependents`);

      await Promise.all(removePromises);

      await this.entity.remove({ [this.idName]: this.getId() }).go();

      this.#invalidateCache();

      return this;
    } catch (error) {
      this.log.error('Failed to remove record', error);
      throw new DataAccessError(
        `Failed to remove entity ${this.entityName} with ID ${this.getId()}`,
        this,
        error,
      );
    }
  }

  /**
   * Saves the current entity to the database. This method must be called after making changes
   * to the entity via their respective setter methods.
   * @async
   * @returns {Promise<BaseModel>} - A promise that resolves to the current instance of the entity
   * after it has been saved.
   * @throws {DataAccessError} - Throws an error if the save operation fails.
   */
  async save() {
    // todo: validate associations
    try {
      this.log.info(`Saving entity ${this.entityName} with ID ${this.getId()}`);

      await this.patcher.save();
      this.#invalidateCache();

      return this;
    } catch (error) {
      this.log.error('Failed to save record', error);
      throw new DataAccessError(
        `Failed to to save entity ${this.entityName} with ID ${this.getId()}`,
        this,
        error,
      );
    }
  }

  /**
   * Converts the entity attributes to a JSON object.
   * @returns {Object} - A JSON representation of the entity attributes.
   */
  toJSON() {
    const attributes = this.schema.getAttributes();

    return Object.keys(attributes).reduce((json, key) => {
      if (this.record[key] !== undefined) {
        // eslint-disable-next-line no-param-reassign
        json[key] = this.record[key];
      }
      return json;
    }, {});
  }
}

export default BaseModel;
