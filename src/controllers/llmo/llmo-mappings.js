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

/**
 * LLMO Sheet Data Mapping Configurations
 *
 * This file contains mapping configurations for transforming LLMO sheet data.
 * Each mapping can transform field names.
 *
 * Structure:
 * - Key: Sheet name (for multi-sheet data) or 'default' (for single sheet data)
 * - Value: Object containing field mappings
 */

export const LLMO_SHEET_MAPPINGS = [{
  name: 'Brand Presence',
  type: 'multi-sheet',
  pattern: 'brandpresence-all-w',
  mappings: {
    all: {
      Question: 'Prompt',
      Topic: 'Category',
      Keyword: 'Topics',
      'Sources Contain Brand Domain': 'Citations',
      sources_contain_branddomain: 'Citations',
      'Answer Contains Brand Name': 'Mentions',
      answer_contains_brandname: 'Mentions',
      Url: 'URL',
    },
    brand_vs_competitors: {
      Topic: 'Category',
      'Which sources they appear': 'Sources',
    },
    brand_sources_exploded: {
      Topic: 'Category',
      Question: 'Prompt',
    },
  },
}];

export default LLMO_SHEET_MAPPINGS;
