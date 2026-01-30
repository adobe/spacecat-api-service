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

/**
 * Mock customer configuration data.
 * Maps IMS Org IDs to their customer configuration.
 * This is a temporary solution until customer configs are stored in the database.
 */

const CUSTOMER_CONFIGS = {
  '1234567890ABCDEF@AdobeOrg': {
    customer: {
      customerName: 'Adobe',
      imsOrgID: '1234567890ABCDEF@AdobeOrg',
      brands: [
        {
          id: 'pending-adobe-photoshop',
          name: 'Adobe Photoshop',
          status: 'active',
          origin: 'ai',
          region: ['GL', 'US', 'GB', 'DE', 'FR', 'JP', 'CN'],
          description: "Adobe's flagship image editing and compositing software used for photography, digital art, and visual design across desktop, web, and mobile.",
          updatedAt: '2026-01-03T09:15:22.000Z',
          updatedBy: 'system',
          vertical: 'Software & Technology',
          urls: [
            {
              value: 'https://www.adobe.com/products/photoshop.html',
              regions: ['GL', 'US', 'GB', 'DE', 'FR', 'JP', 'CN'],
            },
          ],
          socialAccounts: [
            {
              platform: 'twitter',
              url: 'https://x.com/Photoshop',
              regions: ['GL'],
            },
            {
              platform: 'facebook',
              url: 'https://www.facebook.com/Photoshop/',
              regions: ['US', 'GB'],
            },
          ],
          brandAliases: [
            { name: 'Photoshop', regions: ['GL'] },
            { name: 'PS', regions: ['US', 'GB', 'DE', 'FR'] },
            { name: 'Photoshop CC', regions: ['GL'] },
          ],
          competitors: [
            { name: 'Affinity Photo', url: 'https://affinity.serif.com/photo', regions: ['US', 'GB'] },
            { name: 'GIMP', url: 'https://www.gimp.org', regions: ['GL'] },
            { name: 'Corel PaintShop Pro', url: 'https://www.paintshoppro.com', regions: ['US'] },
            { name: 'Pixelmator Pro', url: 'https://www.pixelmator.com/pro/', regions: ['US'] },
          ],
          relatedBrands: [
            { name: 'Wacom', url: 'https://www.wacom.com', regions: ['GL'] },
            { name: 'NVIDIA', url: 'https://www.nvidia.com', regions: ['GL'] },
            { name: 'Pantone', url: 'https://www.pantone.com', regions: ['GL'] },
          ],
          earnedContent: [
            {
              name: 'Wikipedia',
              type: 'encyclopedia',
              coverage_scope: 'product history and feature overview',
              url: 'https://en.wikipedia.org/wiki/Adobe_Photoshop',
              regions: ['GL'],
            },
            {
              name: 'The Verge',
              type: 'digital magazine',
              coverage_scope: 'feature announcements, comparisons, and creative tech coverage',
              url: 'https://www.theverge.com',
              regions: ['US', 'GB'],
            },
            {
              name: 'TechCrunch',
              type: 'digital magazine',
              coverage_scope: 'AI announcements and major product/company news involving Adobe tools',
              url: 'https://techcrunch.com',
              regions: ['US'],
            },
            {
              name: 'CNET',
              type: 'review site',
              coverage_scope: 'how-tos, product guidance, and comparisons',
              url: 'https://www.cnet.com',
              regions: ['US'],
            },
            {
              name: 'Creative Bloq',
              type: 'industry publication',
              coverage_scope: 'tutorials, tips, workflows, and creative software comparisons',
              url: 'https://www.creativebloq.com',
              regions: ['US', 'GB'],
            },
          ],
          categories: [
            {
              id: 'photoshop-photo-editing',
              name: 'Photo Editing',
              status: 'active',
              origin: 'ai',
              updatedAt: '2026-01-03T09:15:22.000Z',
              updatedBy: 'system',
              topics: [
                {
                  id: 'photoshop-topic-1',
                  name: 'Photo Retouching',
                  prompts: [
                    {
                      id: 'photoshop-prompt-1',
                      prompt: 'What is the best photo editing software for portraits?',
                      regions: ['us', 'gb'],
                      origin: 'ai',
                      source: 'api',
                      updatedAt: '2026-01-03T09:15:22.000Z',
                    },
                    {
                      id: 'photoshop-prompt-2',
                      prompt: 'How to remove blemishes from photos?',
                      regions: ['us'],
                      origin: 'ai',
                      source: 'api',
                      updatedAt: '2026-01-03T09:15:22.000Z',
                    },
                  ],
                },
              ],
            },
            {
              id: 'photoshop-digital-art',
              name: 'Digital Art',
              status: 'active',
              origin: 'ai',
              updatedAt: '2026-01-03T09:15:22.000Z',
            },
          ],
        },
        {
          id: 'pending-adobe-acrobat',
          name: 'Adobe Acrobat',
          status: 'pending',
          origin: 'ai',
          region: ['GL', 'US', 'GB', 'DE', 'FR', 'JP'],
          description: "Adobe's PDF platform for viewing, editing, converting, signing, and managing documents across desktop, web, and mobile.",
          updatedAt: '2026-01-05T11:42:33.000Z',
          updatedBy: 'system',
          vertical: 'Professional Services',
          urls: [
            {
              value: 'https://www.adobe.com/acrobat.html',
              regions: ['GL', 'US', 'GB', 'DE', 'FR', 'JP'],
            },
          ],
          socialAccounts: [],
          brandAliases: [
            { name: 'Acrobat', regions: ['GL'] },
            { name: 'Acrobat Pro', regions: ['US', 'GB', 'DE', 'FR'] },
            { name: 'Adobe Reader', regions: ['GL'] },
            { name: 'Acrobat Reader', regions: ['GL'] },
          ],
          competitors: [
            { name: 'Foxit PDF Editor', url: 'https://www.foxit.com/pdf-editor/', regions: ['US', 'GB'] },
            { name: 'Nitro PDF', url: 'https://www.gonitro.com', regions: ['US'] },
            { name: 'PDF Expert', url: 'https://pdfexpert.com', regions: ['US'] },
            { name: 'Soda PDF', url: 'https://www.sodapdf.com', regions: ['US', 'GB'] },
          ],
          relatedBrands: [
            { name: 'Microsoft 365', url: 'https://www.microsoft.com/microsoft-365', regions: ['GL'] },
            { name: 'Dropbox', url: 'https://www.dropbox.com', regions: ['GL'] },
            { name: 'DocuSign', url: 'https://www.docusign.com', regions: ['GL'] },
          ],
          earnedContent: [
            {
              name: 'Wikipedia',
              type: 'encyclopedia',
              coverage_scope: 'product history and capabilities overview',
              url: 'https://en.wikipedia.org/wiki/Adobe_Acrobat',
              regions: ['GL'],
            },
            {
              name: 'PCMag',
              type: 'review site',
              coverage_scope: 'product reviews and comparisons with PDF alternatives',
              url: 'https://www.pcmag.com',
              regions: ['US'],
            },
            {
              name: 'ZDNET',
              type: 'news outlet',
              coverage_scope: 'enterprise workflows, security, and document management coverage',
              url: 'https://www.zdnet.com',
              regions: ['US', 'GB'],
            },
          ],
          categories: [
            {
              id: 'acrobat-document-management',
              name: 'Document Management',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-05T11:42:33.000Z',
            },
            {
              id: 'acrobat-pdf-editing',
              name: 'PDF Editing',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-05T11:42:33.000Z',
            },
          ],
        },
        {
          id: 'pending-adobe-illustrator',
          name: 'Adobe Illustrator',
          status: 'pending',
          origin: 'ai',
          region: ['GL', 'US', 'GB', 'DE', 'FR', 'JP'],
          description: 'Vector graphics design software for creating logos, illustrations, icons, typography, and scalable artwork for print and digital media.',
          updatedAt: '2026-01-08T16:28:44.000Z',
          updatedBy: 'system',
          vertical: 'Software & Technology',
          urls: [
            {
              value: 'https://www.adobe.com/products/illustrator.html',
              regions: ['GL', 'US', 'GB', 'DE', 'FR', 'JP'],
            },
          ],
          socialAccounts: [],
          brandAliases: [
            { name: 'Illustrator', regions: ['GL'] },
            { name: 'AI', regions: ['US', 'GB', 'DE', 'FR'] },
            { name: 'Illustrator CC', regions: ['GL'] },
          ],
          competitors: [
            { name: 'Affinity Designer', url: 'https://affinity.serif.com/designer', regions: ['US', 'GB'] },
            { name: 'CorelDRAW', url: 'https://www.coreldraw.com', regions: ['US', 'DE'] },
            { name: 'Inkscape', url: 'https://inkscape.org', regions: ['GL'] },
          ],
          relatedBrands: [
            { name: 'Wacom', url: 'https://www.wacom.com', regions: ['GL'] },
            { name: 'Pantone', url: 'https://www.pantone.com', regions: ['GL'] },
          ],
          earnedContent: [
            {
              name: 'Wikipedia',
              type: 'encyclopedia',
              coverage_scope: 'product history and vector-graphics positioning',
              url: 'https://en.wikipedia.org/wiki/Adobe_Illustrator',
              regions: ['GL'],
            },
            {
              name: 'Creative Bloq',
              type: 'industry publication',
              coverage_scope: 'tutorials, workflows, and comparisons with vector design alternatives',
              url: 'https://www.creativebloq.com',
              regions: ['US', 'GB'],
            },
            {
              name: 'Smashing Magazine',
              type: 'industry publication',
              coverage_scope: 'design workflows and tooling coverage for UI/UX and visual design',
              url: 'https://www.smashingmagazine.com',
              regions: ['US', 'GB'],
            },
          ],
          categories: [
            {
              id: 'illustrator-logo-design',
              name: 'Logo Design',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-08T16:28:44.000Z',
              updatedBy: 'system',
              topics: [
                {
                  id: 'illustrator-topic-1',
                  name: 'Brand Identity',
                  prompts: [
                    {
                      id: 'illustrator-prompt-1',
                      prompt: 'What software do professionals use for logo design?',
                      regions: ['gl', 'us'],
                      origin: 'ai',
                      source: 'api',
                      updatedAt: '2026-01-08T16:28:44.000Z',
                    },
                  ],
                },
                {
                  id: 'illustrator-topic-2',
                  name: 'Vector Illustration',
                  prompts: [
                    {
                      id: 'illustrator-prompt-2',
                      prompt: 'How to create scalable graphics for print?',
                      regions: ['us', 'gb'],
                      origin: 'ai',
                      source: 'api',
                      updatedAt: '2026-01-08T16:28:44.000Z',
                    },
                  ],
                },
              ],
            },
            {
              id: 'illustrator-vector-graphics',
              name: 'Vector Graphics',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-08T16:28:44.000Z',
            },
          ],
        },
        {
          id: 'pending-adobe-premiere-pro',
          name: 'Adobe Premiere Pro',
          status: 'pending',
          origin: 'ai',
          region: ['GL', 'US', 'GB', 'DE', 'FR', 'JP'],
          description: 'Professional non-linear video editing software used for film, television, and online video production.',
          updatedAt: '2026-01-10T13:55:11.000Z',
          updatedBy: 'system',
          vertical: 'News & Entertainment',
          urls: [
            {
              value: 'https://www.adobe.com/products/premiere.html',
              regions: ['GL', 'US', 'GB', 'DE', 'FR', 'JP'],
            },
          ],
          socialAccounts: [],
          brandAliases: [
            { name: 'Premiere Pro', regions: ['GL'] },
            { name: 'Premiere', regions: ['US', 'GB', 'DE', 'FR'] },
            { name: 'Pr', regions: ['US'] },
          ],
          competitors: [
            { name: 'DaVinci Resolve', url: 'https://www.blackmagicdesign.com/products/davinciresolve', regions: ['GL'] },
            { name: 'Final Cut Pro', url: 'https://www.apple.com/final-cut-pro/', regions: ['US'] },
            { name: 'Avid Media Composer', url: 'https://www.avid.com/media-composer', regions: ['US'] },
          ],
          relatedBrands: [
            { name: 'Frame.io', url: 'https://frame.io', regions: ['GL'] },
            { name: 'NVIDIA', url: 'https://www.nvidia.com', regions: ['GL'] },
          ],
          earnedContent: [
            {
              name: 'Wikipedia',
              type: 'encyclopedia',
              coverage_scope: 'product history and feature overview',
              url: 'https://en.wikipedia.org/wiki/Adobe_Premiere_Pro',
              regions: ['GL'],
            },
            {
              name: 'No Film School',
              type: 'industry publication',
              coverage_scope: 'editing workflows, feature updates, and production techniques',
              url: 'https://nofilmschool.com',
              regions: ['US'],
            },
            {
              name: 'CineD',
              type: 'industry publication',
              coverage_scope: 'video production tooling coverage and workflow comparisons',
              url: 'https://www.cined.com',
              regions: ['US', 'GB'],
            },
          ],
          categories: [
            {
              id: 'premiere-video-editing',
              name: 'Video Editing',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-10T13:55:11.000Z',
            },
            {
              id: 'premiere-film-production',
              name: 'Film Production',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-10T13:55:11.000Z',
            },
          ],
        },
        {
          id: 'pending-adobe-creative-cloud',
          name: 'Adobe Creative Cloud',
          status: 'pending',
          origin: 'ai',
          region: ['GL'],
          description: "Adobe's subscription suite of creative apps and services, bundling tools for photo, design, video, UX, and creative collaboration.",
          updatedAt: '2026-01-14T08:19:56.000Z',
          updatedBy: 'system',
          vertical: 'Software & Technology',
          urls: [
            {
              value: 'https://www.adobe.com/creativecloud.html',
              regions: ['GL'],
            },
          ],
          socialAccounts: [
            {
              platform: 'twitter',
              url: 'https://x.com/creativecloud',
              regions: ['GL'],
            },
          ],
          brandAliases: [
            { name: 'Creative Cloud', regions: ['GL'] },
            { name: 'CC', regions: ['GL'] },
          ],
          competitors: [
            { name: 'Canva', url: 'https://www.canva.com', regions: ['GL'] },
            { name: 'Affinity (Serif)', url: 'https://affinity.serif.com', regions: ['US', 'GB'] },
            { name: 'CorelDRAW Graphics Suite', url: 'https://www.coreldraw.com', regions: ['US'] },
          ],
          relatedBrands: [
            { name: 'Wacom', url: 'https://www.wacom.com', regions: ['GL'] },
            { name: 'Pantone', url: 'https://www.pantone.com', regions: ['GL'] },
            { name: 'NVIDIA', url: 'https://www.nvidia.com', regions: ['GL'] },
          ],
          earnedContent: [
            {
              name: 'Wikipedia',
              type: 'encyclopedia',
              coverage_scope: 'suite overview, history, and included products',
              url: 'https://en.wikipedia.org/wiki/Adobe_Creative_Cloud',
              regions: ['GL'],
            },
            {
              name: 'The Verge',
              type: 'digital magazine',
              coverage_scope: 'major suite changes, pricing, and creative software coverage',
              url: 'https://www.theverge.com',
              regions: ['US', 'GB'],
            },
            {
              name: 'Wired',
              type: 'digital magazine',
              coverage_scope: 'creative technology trends and major software ecosystem coverage',
              url: 'https://www.wired.com',
              regions: ['US', 'GB'],
            },
          ],
          categories: [
            {
              id: 'creative-cloud-subscription',
              name: 'Creative Software Subscription',
              status: 'pending',
              origin: 'ai',
              updatedAt: '2026-01-14T08:19:56.000Z',
            },
          ],
        },
      ],
      availableVerticals: [
        'News & Entertainment',
        'Software & Technology',
        'IT Services',
        'Manufacture',
        'Healthcare',
        'Pharmaceutical',
        'Foods & Nutrition',
        'Transportation',
        'Hospitality',
        'Travel & Tourism',
        'Automotive',
        'Freight & Logistics',
        'Retail',
        'FSI (Financial Services & Insurance)',
        'Energy',
        'NGO',
        'Education',
        'Real Estate & Construction',
        'Legal Services',
        'Telecommunications',
        'Professional Services',
        'Government & Public Services',
      ],
    },
  },
  // Add more customer configs here as they become available
};

/**
 * Gets customer configuration by IMS Org ID
 * @param {string} imsOrgId - The IMS Organization ID
 * @returns {object|null} Customer configuration or null if not found
 */
export function getCustomerConfigByImsOrgId(imsOrgId) {
  return CUSTOMER_CONFIGS[imsOrgId] || null;
}

export default {
  getCustomerConfigByImsOrgId,
};
