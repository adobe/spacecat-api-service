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
export const emptyResponse = {
  ':names': [
    'results',
    'meta',
  ],
  ':type': 'multi-sheet',
  ':version': 3,
  results: {
    limit: 1,
    offset: 0,
    total: 0,
    data: [],
    columns: [],
  },
  meta: {
    limit: 9,
    offset: 0,
    total: 9,
    columns: [
      'name',
      'value',
      'type',
    ],
    data: [
      {
        name: 'description',
        value: 'List of domains along with some summary data.',
        type: 'query description',
      },
      {
        name: 'timezone',
        value: 'UTC',
        type: 'request parameter',
      },
      {
        name: 'device',
        value: 'all',
        type: 'request parameter',
      },
      {
        name: 'interval',
        value: 30,
        type: 'request parameter',
      },
      {
        name: 'offset',
        value: 0,
        type: 'request parameter',
      },
      {
        name: 'startdate',
        value: '2022-02-01',
        type: 'request parameter',
      },
      {
        name: 'enddate',
        value: '2022-05-28',
        type: 'request parameter',
      },
      {
        name: 'url',
        value: '-',
        type: 'request parameter',
      },
      {
        name: 'limit',
        value: null,
        type: 'request parameter',
      },
    ],
  },
};

export const fullResponse = {
  ':names': [
    'results',
    'meta',
  ],
  ':type': 'multi-sheet',
  ':version': 3,
  results: {
    limit: 3,
    offset: 0,
    total: 3,
    data: [
      {
        hostname: 'adobe.com',
        ims_org_id: '',
        first_visit: '2023-10-17',
        last_visit: '2023-11-16',
        current_month_visits: '50373592',
        total_visits: '82521264',
      },
      {
        hostname: 'bamboohr.com',
        ims_org_id: '63C70EF1613FCF530A495EE2@AdobeOrg',
        first_visit: '2023-10-17',
        last_visit: '2023-11-16',
        current_month_visits: '2024813',
        total_visits: '12041012',
      },
      {
        hostname: 'nurtec.com',
        ims_org_id: null,
        first_visit: '2023-10-17',
        last_visit: '2023-11-16',
        current_month_visits: '3025930',
        total_visits: '5819761',
      },
    ],
    columns: [
      'hostname',
      'ims_org_id',
      'first_visit',
      'last_visit',
      'current_month_visits',
      'total_visits',
    ],
  },
  meta: {
    limit: 9,
    offset: 0,
    total: 9,
    columns: [
      'name',
      'value',
      'type',
    ],
    data: [
      {
        name: 'description',
        value: 'List of domains along with some summary data.',
        type: 'query description',
      },
      {
        name: 'timezone',
        value: 'UTC',
        type: 'request parameter',
      },
      {
        name: 'device',
        value: 'all',
        type: 'request parameter',
      },
      {
        name: 'interval',
        value: 30,
        type: 'request parameter',
      },
      {
        name: 'offset',
        value: 0,
        type: 'request parameter',
      },
      {
        name: 'startdate',
        value: '2022-02-01',
        type: 'request parameter',
      },
      {
        name: 'enddate',
        value: '2022-05-28',
        type: 'request parameter',
      },
      {
        name: 'url',
        value: '-',
        type: 'request parameter',
      },
      {
        name: 'limit',
        value: null,
        type: 'request parameter',
      },
    ],
  },
};
