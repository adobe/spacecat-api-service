/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { removeElectroProperties } from '../../../src/util/util.js';

const randomDate = (start, end) => {
  if (start.getTime() >= end.getTime()) {
    throw new Error('start must be before end');
  }
  return new Date(
    start.getTime() + Math.random() * (end.getTime() - start.getTime()),
  );
};

// Generates a random decimal number with given precision
const getRandomDecimal = (precision) => parseFloat(Math.random().toFixed(precision));

// Generates a random integer up to a given maximum
const getRandomInt = (max) => Math.floor(Math.random() * max);

const sanitizeRecord = (record, idName) => {
  const sanitizedRecord = removeElectroProperties({ ...record });

  delete sanitizedRecord[idName];
  delete sanitizedRecord.createdAt;
  delete sanitizedRecord.updatedAt;

  return sanitizedRecord;
};

const getExecutionOptions = (options) => {
  const { limit, order = 'asc' } = options;

  return {
    ...(limit > 0 && { limit }),
    order,
  };
};

export {
  getExecutionOptions,
  getRandomDecimal,
  getRandomInt,
  randomDate,
  removeElectroProperties,
  sanitizeRecord,
};
