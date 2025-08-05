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