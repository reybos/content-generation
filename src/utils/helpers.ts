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

/* END GENAI */