/**
 * Prompt System - Simplified prompt management
 *
 * Features:
 * - File-based prompt storage in templates/
 * - Snippet composition via {{snippet:name}} syntax
 * - Conditional blocks via {{#if flag}}...{{/if}} syntax
 * - Variable interpolation via {{variable}} syntax
 */

// Types
import type { PromptId } from './types';
export type { PromptId, SnippetId, LoadedPrompt } from './types';

// Loader functions
export {
  loadPrompt,
  loadSnippet,
  buildPrompt,
  interpolateVariables,
  processSnippets,
  processConditionalBlocks,
} from './loader';

// Prompt IDs constant
export const PROMPT_IDS = {
  INTERACTIVE_OUTLINES: 'interactive-outlines',
  TASK_ENGINE_OUTLINES: 'task-engine-outlines',
  OUTLINE_REVISION: 'outline-revision',
  COURSE_DIRECTION: 'course-direction',
  COURSE_OUTCOMES: 'course-outcomes',
  COURSE_KNOWLEDGE: 'course-knowledge',
  COURSE_OUTLINE: 'course-outline',
  COURSE_TEACHING: 'course-teaching',
  COURSE_ASSESSMENT: 'course-assessment',
  COURSE_SERIES_CHAPTERS: 'course-series-chapters',
  COURSE_SERIES_SECTIONS: 'course-series-sections',
  COURSE_SERIES_ITEMS: 'course-series-items',
  COURSE_SERIES_DESIGN: 'course-series-design',
  COURSE_SERIES_DIRECTION: 'course-series-direction',
  COURSE_SERIES_OBJECTIVES: 'course-series-objectives',
  COURSE_SERIES_KNOWLEDGE: 'course-series-knowledge',
  WEB_SEARCH_QUERY_REWRITE: 'web-search-query-rewrite',
} as const satisfies Record<string, PromptId>;
