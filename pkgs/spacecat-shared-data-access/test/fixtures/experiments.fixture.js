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

const experiments = [
  {
    experimentId: '745292e2-52af-4b66-b63b-fca68019a42b',
    siteId: '5d6d4439-6659-46c2-b646-92d110fa5a52',
    expId: 'experiment-1',
    name: 'Experiment 1',
    url: 'https://example0.com/page-1',
    status: 'ACTIVE',
    type: 'full',
    variants: [
      {
        label: 'Challenger 1',
        name: 'challenger-1',
        interactionsCount: 10,
        p_value: 'coming soon',
        split: 0.8,
        url: 'https://example0.com/page-1/variant-1',
        views: 100,
        metrics: [
          {
            selector: '.header .button',
            type: 'click',
            value: 2,
          },
        ],
      },
      {
        label: 'Challenger 2',
        name: 'challenger-2',
        interactionsCount: 20,
        p_value: 'coming soon',
        metrics: [],
        split: 0.8,
        url: 'https://example0.com/page-2/variant-2',
        views: 200,
      },
    ],
    startDate: '2024-11-29T07:45:55.952Z',
    endDate: '2024-12-09T07:45:55.954Z',
    updatedBy: 'scheduled-experiment-audit',
  },
  {
    experimentId: '3451b539-df79-4033-b300-82904f7a3840',
    siteId: '5d6d4439-6659-46c2-b646-92d110fa5a52',
    expId: 'experiment-2',
    name: 'Experiment 2',
    url: 'https://example0.com/page-2',
    status: 'ACTIVE',
    type: 'full',
    variants: [
      {
        label: 'Challenger 2',
        name: 'challenger-2',
        interactionsCount: 20,
        p_value: 'coming soon',
        split: 0.8,
        url: 'https://example0.com/page-2/variant-2',
        views: 200,
        metrics: [
          {
            selector: '.header .button',
            type: 'click',
            value: 4,
          },
        ],
      },
      {
        label: 'Challenger 3',
        name: 'challenger-3',
        interactionsCount: 30,
        p_value: 'coming soon',
        metrics: [],
        split: 0.8,
        url: 'https://example0.com/page-3/variant-3',
        views: 300,
      },
    ],
    startDate: '2024-11-29T07:45:55.952Z',
    endDate: '2024-12-09T07:45:55.954Z',
    updatedBy: 'scheduled-experiment-audit',
  },
  {
    experimentId: '111385e5-5680-48bd-8a77-f6b69df6f1b7',
    siteId: '5d6d4439-6659-46c2-b646-92d110fa5a52',
    expId: 'experiment-3',
    name: 'Experiment 3',
    url: 'https://example0.com/page-3',
    status: 'ACTIVE',
    type: 'full',
    variants: [
      {
        label: 'Challenger 3',
        name: 'challenger-3',
        interactionsCount: 30,
        p_value: 'coming soon',
        split: 0.8,
        url: 'https://example0.com/page-3/variant-3',
        views: 300,
        metrics: [
          {
            selector: '.header .button',
            type: 'click',
            value: 6,
          },
        ],
      },
      {
        label: 'Challenger 4',
        name: 'challenger-4',
        interactionsCount: 40,
        p_value: 'coming soon',
        metrics: [],
        split: 0.8,
        url: 'https://example0.com/page-4/variant-4',
        views: 400,
      },
    ],
    startDate: '2024-11-29T07:45:55.952Z',
    endDate: '2024-12-09T07:45:55.954Z',
    updatedBy: 'scheduled-experiment-audit',
  },
];

export default experiments;
