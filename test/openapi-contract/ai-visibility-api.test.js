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

import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import yaml from 'js-yaml';
import { COUNTRY_ENUM } from '@quazar/ai-seo-ts/common/types_pb.js';

describe('AI Visibility OpenAPI contract', () => {
  it('keeps the documented country enum synchronized with the vendored country enum', () => {
    const schemasUrl = new URL('../../docs/openapi/schemas.yaml', import.meta.url);
    const schemas = yaml.load(readFileSync(schemasUrl, 'utf8'));
    const documentedValues = schemas?.AiVisibilitySemrushCountry?.enum;

    expect(
      documentedValues,
      'AiVisibilitySemrushCountry.enum must exist',
    ).to.be.an('array');

    const documentedCountryCodes = documentedValues
      .filter((code) => typeof code === 'string' && /^[A-Z]{2}$/.test(code))
      .sort((a, b) => a.localeCompare(b));
    const vendoredCountryCodes = Object.keys(COUNTRY_ENUM)
      .filter((code) => /^[A-Z]{2}$/.test(code))
      .sort((a, b) => a.localeCompare(b));

    expect(documentedCountryCodes).to.deep.equal(vendoredCountryCodes);
  });
});
