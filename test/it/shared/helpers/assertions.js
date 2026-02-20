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

import { expect } from 'chai';

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Asserts that a value is a valid ISO 8601 timestamp within a reasonable range.
 * Does NOT assert exact values — timestamps are non-deterministic.
 *
 * @param {string} value - The value to check
 * @param {string} [label] - Optional label for error messages
 */
export function expectISOTimestamp(value, label = 'timestamp') {
  expect(value, `${label} should be a string`).to.be.a('string');
  expect(value, `${label} should match ISO 8601`).to.match(ISO_8601_REGEX);

  const parsed = new Date(value);
  expect(parsed.toString(), `${label} should be a valid date`).to.not.equal('Invalid Date');

  // Reasonable range: within the last hour to now + 1 minute (clock tolerance)
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const oneMinuteAhead = now + 60_000;
  expect(parsed.getTime(), `${label} should be recent`)
    .to.be.within(oneHourAgo, oneMinuteAhead);
}

/**
 * Sorts an array of objects by `id` field for deterministic comparison.
 *
 * @param {Array<object>} arr - Array of objects with `id` fields
 * @returns {Array<object>} Sorted copy (original not mutated)
 */
export function sortById(arr) {
  return [...arr].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
}

/**
 * Treats `null` and `undefined` as equivalent for comparison.
 * Returns `null` if the value is nullish, otherwise returns the value.
 *
 * @param {*} value
 * @returns {*}
 */
export function normalizeNull(value) {
  return value == null ? null : value;
}

/**
 * Asserts that two values are equivalent, treating null/undefined as the same.
 *
 * @param {*} actual
 * @param {*} expected
 * @param {string} [label]
 */
export function expectNullEquivalent(actual, expected, label = 'value') {
  expect(normalizeNull(actual), label).to.deep.equal(normalizeNull(expected));
}

/**
 * Asserts the 207 batch response envelope structure.
 *
 * Expected shape (e.g., for suggestions):
 * {
 *   metadata: { total, success, failed },
 *   suggestions: [{ status, ... }, ...]
 * }
 *
 * @param {object} res - HTTP response { status, body }
 * @param {number} expectedTotal - Expected total count
 * @param {string} arrayKey - The entity-specific key for the items array
 *   (e.g., 'suggestions', 'fixes')
 */
export function expectBatch207(res, expectedTotal, arrayKey) {
  expect(res.status, 'batch status').to.equal(207);
  expect(res.body, 'batch body').to.be.an('object');
  expect(res.body.metadata, 'batch metadata').to.be.an('object');
  expect(res.body.metadata.total, 'batch total').to.equal(expectedTotal);
  expect(res.body.metadata.success, 'batch success count').to.be.a('number');
  expect(res.body.metadata.failed, 'batch failed count').to.be.a('number');
  expect(res.body.metadata.success + res.body.metadata.failed, 'success + failed = total')
    .to.equal(expectedTotal);
  expect(res.body[arrayKey], `batch ${arrayKey}`)
    .to.be.an('array').with.lengthOf(expectedTotal);
}

/**
 * Asserts the 201 batch-create response envelope.
 *
 * Expected shape (used by sentiment + url-store endpoints):
 * {
 *   metadata: { total, success, failure },
 *   failures: [],
 *   items: [...]
 * }
 *
 * @param {object} res - HTTP response { status, body }
 * @param {number} expectedTotal - Expected total count
 */
export function expectBatch201(res, expectedTotal) {
  expect(res.status, 'batch status').to.equal(201);
  expect(res.body, 'batch body').to.be.an('object');
  expect(res.body.metadata, 'batch metadata').to.be.an('object');
  expect(res.body.metadata.total, 'batch total').to.equal(expectedTotal);
  expect(res.body.metadata.success, 'batch success count').to.be.a('number');
  expect(res.body.metadata.failure, 'batch failure count').to.be.a('number');
  expect(res.body.metadata.success + res.body.metadata.failure, 'success + failure = total')
    .to.equal(expectedTotal);
  expect(res.body.failures, 'batch failures').to.be.an('array');
  expect(res.body.items, 'batch items').to.be.an('array');
}

/**
 * Asserts that a field has a valid format but doesn't assert exact value.
 * Useful for `updatedBy`, `createdBy` that differ by auth context.
 *
 * @param {*} value - The value to check
 * @param {string} [label]
 */
export function expectNonEmptyString(value, label = 'field') {
  expect(value, `${label} should be a string`).to.be.a('string');
  expect(value, `${label} should not be empty`).to.have.length.greaterThan(0);
}
