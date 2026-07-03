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

/*
 * Adapts the agent's free-text brief into the shape the Elmo UI already renders
 * (briefSlides / briefSections in project-elmo-ui's MarketingConsultantDataset).
 *
 * POC: the agent returns short markdown-ish prose. We surface it verbatim as one
 * BriefSection and derive a single summary BriefSlide from its lines. A production
 * adapter would ask the agent for structured JSON and map fields 1:1.
 */

/**
 * @param {string} text - raw brief text returned by the agent
 * @returns {{ briefSlides: object[], briefSections: object[] }}
 */
export function adaptBriefText(text) {
  const clean = (text || '').trim();

  const bullets = clean
    .split('\n')
    .map((line) => line.replace(/^[\s#*\-\d.)]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);

  const briefSlides = [
    {
      id: 'agent-brief',
      title: 'Adobe Marketing Agent',
      subtitle: 'Live-generated GEO brief',
      highlight: 'Generated from your data sources',
      bullets: bullets.length > 0 ? bullets : ['No content returned by the agent.'],
    },
  ];

  const briefSections = [
    {
      id: 'agent-brief',
      title: 'AI-generated strategic brief',
      contentMarkdown: clean || '_No content returned by the agent._',
    },
  ];

  return { briefSlides, briefSections };
}
