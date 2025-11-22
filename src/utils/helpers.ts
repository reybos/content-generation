/* START GENAI */

import { GenerationData, NewFormatWithArraysData } from '../types';

/**
 * Helper functions for the content generation worker
 */

/**
 * Sleep for the specified number of milliseconds
 * @param ms Number of milliseconds to sleep
 * @returns Promise that resolves after the specified delay
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if data is in single video format (song + video_prompt)
 * @param data The data to check
 * @returns True if data is in single video format
 */
export function isSingleVideoFormat(data: any): boolean {
    return data && 
           data.song && 
           typeof data.song.song_text === 'string' &&
           typeof data.song.music_prompt === 'string' &&
           data.video_prompt && 
           typeof data.video_prompt.video_prompt === 'string' &&
           typeof data.video_prompt.line === 'string' &&
           typeof data.video_prompt.index === 'number' &&
           typeof data.title === 'string';
}

/**
 * Check if data is in song with animal format (NewFormatWithArraysData)
 * @param data The data to check
 * @returns True if data is in song with animal format
 */
export function isSongWithAnimal(data: any): data is NewFormatWithArraysData {
    return data && 
           typeof data.global_style === 'string' && 
           Array.isArray(data.prompts) && 
           data.prompts.length > 0 &&
           Array.isArray(data.video_prompts) && 
           data.video_prompts.length > 0 &&
           Array.isArray(data.titles);
}

/**
 * Check if data is in study format (GenerationData)
 * @param data The data to check
 * @returns True if data is in study format
 */
export function isStudy(data: any): data is GenerationData {
    return data && 
           data.script &&
           data.narration &&
           Array.isArray(data.enhancedMedia) && 
           data.enhancedMedia.length > 0;
}

/**
 * Check if data is in song with animal format with video prompts
 * @param data The data to check
 * @returns True if data has video_prompts array
 */
export function isSongWithAnimalWithVideoPrompts(data: any): boolean {
    return data && data.video_prompts && Array.isArray(data.video_prompts) && data.video_prompts.length > 0;
}

/**
 * Check if data is in study format with enhanced media
 * @param data The data to check
 * @returns True if data has enhancedMedia array
 */
export function isStudyWithEnhancedMedia(data: any): boolean {
    return data && data.enhancedMedia && Array.isArray(data.enhancedMedia) && data.enhancedMedia.length > 0;
}

/**
 * Check if data is in halloweenTransform format
 * @param data The data to check
 * @param filename The filename to check for halloweenTransform pattern
 * @returns True if data is in halloweenTransform format
 */
export function isHalloweenTransform(data: any, filename: string): boolean {
    return data && 
           Array.isArray(data.video_prompts) && 
           data.video_prompts.length > 0 &&
           data.video_prompts.every((vp: any) => 
               typeof vp.prompt === 'string' && 
               typeof vp.video_prompt === 'string' &&
               typeof vp.line === 'string' &&
               typeof vp.index === 'number'
           ) &&
           filename.toLowerCase().includes('halloweentransform');
}

/* END GENAI */