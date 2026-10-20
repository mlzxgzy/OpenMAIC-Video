/**
 * Simplified prompt system type definitions
 */

/**
 * Prompt template identifier
 */
export type PromptId =
  | 'interactive-outlines'
  | 'task-engine-outlines'
  | 'outline-revision'
  | 'course-direction'
  | 'course-outcomes'
  | 'course-knowledge'
  | 'course-outline'
  | 'course-teaching'
  | 'course-assessment'
  | 'course-series-chapters'
  | 'course-series-sections'
  | 'course-series-items'
  | 'course-series-design'
  | 'course-series-direction'
  | 'course-series-objectives'
  | 'course-series-knowledge'
  | 'web-search-query-rewrite';

/**
 * Snippet identifier
 */
export type SnippetId =
  | 'json-output-rules'
  | 'element-types'
  | 'action-types'
  | 'image-instructions'
  | 'video-instructions'
  | 'media-safety-guidelines'
  | 'slide-image-instructions'
  | 'slide-generated-image-instructions'
  | 'slide-video-instructions';

/**
 * Loaded prompt template
 */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}

export type PromptVariableDefaults = Partial<Record<PromptId, Readonly<Record<string, unknown>>>>;
