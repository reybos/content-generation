/* START GENAI */
import { z } from 'zod';

// Scene schema and type
export const SceneSchema = z.object({
    title: z.string(),
    description: z.string(),
    narration: z.string()
});
export type Scene = z.infer<typeof SceneSchema>;

// Character schema and type
export const CharacterSchema = z.object({
    character_type: z.string(),
    name: z.string(),
    appearance: z.string(),
    personality: z.string(),
    gestures: z.string(),
    outfit: z.string(),
    background: z.string()
});
export type Character = z.infer<typeof CharacterSchema>;

// Enhanced media schema and type
export const EnhancedMediaSchema = z.object({
    scene: z.union([z.number(), z.string()]),
    scene_type: z.string(),
    image_prompt: z.string(),
    video_prompt: z.string(),
    duration: z.union([z.number(), z.string()]).optional(),
});
export type EnhancedMedia = z.infer<typeof EnhancedMediaSchema>;

// Script schema and type
export const ScriptSchema = z.object({
    introduction: z.string(),
    scenes: z.array(SceneSchema),
    finale: z.string()
});
export type Script = z.infer<typeof ScriptSchema>;

// Complete generation data schema and type
export const GenerationDataSchema = z.object({
    script: ScriptSchema,
    character: CharacterSchema,
    enhancedMedia: z.array(EnhancedMediaSchema),
    music: z.string(),
    titleDesc: z.string(),
    hashtags: z.string()
});
export type GenerationData = z.infer<typeof GenerationDataSchema>;

// New format schemas and types
export const PromptSchema = z.object({
    line: z.string(),
    prompt: z.string()
});
export type Prompt = z.infer<typeof PromptSchema>;

export const VideoPromptSchema = z.object({
    line: z.string(),
    video_prompt: z.string()
});
export type VideoPrompt = z.infer<typeof VideoPromptSchema>;

export const NewFormatDataSchema = z.object({
    global_style: z.string(),
    prompts: z.array(PromptSchema),
    title: z.string(),
    description: z.string(),
    hashtags: z.string()
});
export type NewFormatData = z.infer<typeof NewFormatDataSchema>;

// New format with video prompts schema and type
export const NewFormatWithVideoDataSchema = z.object({
    global_style: z.string(),
    prompts: z.array(PromptSchema),
    video_prompts: z.array(VideoPromptSchema),
    title: z.string(),
    description: z.string(),
    hashtags: z.string()
});
export type NewFormatWithVideoData = z.infer<typeof NewFormatWithVideoDataSchema>;

// Additional frame schema and type
export const AdditionalFrameSchema = z.object({
    index: z.number(),
    lines: z.array(z.string()),
    group_image_prompt: z.string(),
    group_video_prompt: z.string()
});
export type AdditionalFrame = z.infer<typeof AdditionalFrameSchema>;

// New format with arrays for titles, descriptions, and hashtags
export const NewFormatWithArraysDataSchema = z.object({
    global_style: z.string(),
    prompts: z.array(PromptSchema),
    video_prompts: z.array(VideoPromptSchema),
    titles: z.array(z.string()),
    descriptions: z.array(z.string()),
    hashtags: z.array(z.string()),
    additional_frames: z.array(AdditionalFrameSchema).optional()
});
export type NewFormatWithArraysData = z.infer<typeof NewFormatWithArraysDataSchema>;

// Union type for all formats
export const ContentDataSchema = z.union([
    GenerationDataSchema, 
    NewFormatDataSchema, 
    NewFormatWithVideoDataSchema,
    NewFormatWithArraysDataSchema
]);
export type ContentData = z.infer<typeof ContentDataSchema>;