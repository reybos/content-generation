/* START GENAI */

import { GenerationData, ScenePromptsData } from '../types';

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
 * Halloween transform pattern (specific pattern for transform format)
 */
export const HALLOWEEN_TRANSFORM_PATTERN = 'halloweentransform';

/**
 * Halloween file patterns for format detection
 */
export const HALLOWEEN_FILE_PATTERNS = [
    'halloweendance',
    HALLOWEEN_TRANSFORM_PATTERN,
    'halloweenpatchwork',
    'halloweentransformtwoframe'
];

/**
 * Check if filename matches any Halloween file pattern
 * @param filename The filename to check
 * @returns True if filename matches any Halloween pattern
 */
export function isHalloweenFile(filename: string): boolean {
    const lowerFilename = filename.toLowerCase();
    return HALLOWEEN_FILE_PATTERNS.some(pattern => 
        lowerFilename.includes(pattern)
    );
}

/**
 * Check if filename is in halloweenTransform format
 * @param filename The filename to check for halloweenTransform pattern
 * @returns True if filename contains 'halloweentransform'
 */
export function isHalloweenTransform(filename: string): boolean {
    return filename.toLowerCase().includes(HALLOWEEN_TRANSFORM_PATTERN);
}

/**
 * Poems file pattern for format detection
 */
export const POEMS_FILE_PATTERN = 'poems';

/**
 * Poems direct video file pattern for format detection
 */
export const POEMS_DIRECT_VIDEO_PATTERN = 'poems-direct-video';

/**
 * Check if filename matches poems file pattern
 * @param filename The filename to check
 * @returns True if filename matches poems pattern (contains 'poems')
 */
export function isPoemsFile(filename: string): boolean {
    const lowerFilename = filename.toLowerCase();
    return lowerFilename.includes(POEMS_FILE_PATTERN) && !lowerFilename.includes(POEMS_DIRECT_VIDEO_PATTERN);
}

/**
 * Check if filename matches poems direct video file pattern
 * @param filename The filename to check
 * @returns True if filename matches poems-direct-video pattern (contains 'poems-direct-video')
 */
export function isPoemsDirectVideoFile(filename: string): boolean {
    const lowerFilename = filename.toLowerCase();
    return lowerFilename.includes(POEMS_DIRECT_VIDEO_PATTERN);
}

/**
 * Validation result interface
 */
export interface ValidationResult {
    isValid: boolean;
    error?: string;
}

/**
 * Validate prompt length against maximum allowed length
 * @param prompt The prompt to validate
 * @param maxLength Maximum allowed length for the prompt
 * @returns Validation result with isValid flag and optional error message
 */
export function validatePromptLength(prompt: string, maxLength: number): ValidationResult {
    if (prompt.length > maxLength) {
        return {
            isValid: false,
            error: `Prompt length (${prompt.length}) exceeds maximum allowed length (${maxLength})`
        };
    }
    return { isValid: true };
}

/* END GENAI */