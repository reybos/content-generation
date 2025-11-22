/* START GENAI */

import { fal } from '@fal-ai/client';
import fs from 'fs-extra';
import path from 'path';
import {Logger, HALLOWEEN_FILE_PATTERNS, isHalloweenFile} from '../../utils';

interface ImageGenerationStatus {
    requestId: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    startTime: number;
}

/**
 * Service for generating images from prompts using the fal.ai API
 */
export class ImageService {
    private logger: Logger;
    private readonly POLLING_INTERVAL_MS = 5000; // 5 seconds
    private readonly MAX_WAIT_TIME_MS = 300000; // 5 minutes
    private readonly DEFAULT_IMAGE_MODEL = 'fal-ai/minimax/image-01';
    private readonly HALLOWEEN_IMAGE_MODEL = 'fal-ai/imagen4/preview';

    /**
     * Create a new ImageService instance
     */
    constructor() {
        this.logger = new Logger();
    }

    /**
     * Determine the appropriate model based on filename
     */
    private getModelForGeneration(filename: string): string {
        if (isHalloweenFile(filename)) {
            this.logger.info(`Using Halloween model for file: ${filename}`);
            return this.HALLOWEEN_IMAGE_MODEL;
        }
        
        this.logger.info(`Using default model for file: ${filename}`);
        return this.DEFAULT_IMAGE_MODEL;
    }

    /**
     * Generate an image from a prompt and save it to the specified path
     */
    public async generateImage(prompt: string, outputPath: string, filename?: string): Promise<{ requestId: string, prompt: string } | void> {
        this.logger.info(`Generating image with prompt: ${prompt}`);
        this.logger.info(`Image will be saved to: ${outputPath}`);

        // Determine the appropriate model
        const model = this.getModelForGeneration(filename || '');
        this.logger.info(`Using model: ${model}`);

        try {
            const inputParams: any = {
                prompt,
                aspect_ratio: '9:16',
                // aspect_ratio: '16:9',
                num_images: 1,
            };

            // Add resolution parameter for Halloween model
            if (model === this.HALLOWEEN_IMAGE_MODEL) {
                inputParams.resolution = '1K';
            }

            const { request_id } = await this.submitWithRetry(model, {
                input: inputParams,
            });

            this.logger.info(`Image generation request submitted with ID: ${request_id}`);

            const status: ImageGenerationStatus = {
                requestId: request_id,
                status: 'pending',
                startTime: Date.now(),
            };

            const result = await this.pollForResult(status, model);

            if (
                result &&
                result.data &&
                Array.isArray(result.data.images) &&
                result.data.images.length > 0
            ) {
                const imageUrl = result.data.images[0].url;
                const outputDir = path.dirname(outputPath);

                await fs.ensureDir(outputDir);

                await this.downloadImageWithRetry(imageUrl, outputPath);

                this.logger.info(`Image generated successfully: ${outputPath}`);
                return { requestId: request_id, prompt };
            } else {
                throw new Error('No images returned from the API');
            }
        } catch (error: any) {
            this.logger.error(`Error generating image: ${error}`);
            throw new Error(`Failed to generate image: ${error}`);
        }
    }

    /**
     * Poll for the result of an image generation request
     */
    private async pollForResult(status: ImageGenerationStatus, model: string): Promise<any> {
        while (true) {
            try {
                const elapsedTime = Date.now() - status.startTime;
                if (elapsedTime > this.MAX_WAIT_TIME_MS) {
                    throw new Error(
                        `Image generation timed out after ${this.MAX_WAIT_TIME_MS / 1000} seconds`
                    );
                }

                const statusResponse = await this.getStatusWithRetry(model, {
                    requestId: status.requestId,
                    logs: true,
                });

                const apiStatus = (statusResponse as any).status as string;

                switch (apiStatus) {
                    case 'COMPLETED':
                        status.status = 'completed';
                        break;
                    case 'FAILED':
                        status.status = 'failed';
                        break;
                    case 'IN_PROGRESS':
                        status.status = 'in_progress';
                        break;
                    default:
                        status.status = 'pending';
                }

                if ('logs' in statusResponse && Array.isArray(statusResponse.logs)) {
                    statusResponse.logs.forEach((log: { message: string }) => {
                        this.logger.info(`Image generation progress: ${log.message}`);
                    });
                }

                if (status.status === 'completed') {
                    this.logger.info(`Image generation request ${status.requestId} completed`);
                    return await this.getResultWithRetry(model, {
                        requestId: status.requestId,
                    });
                }

                if (status.status === 'failed') {
                    throw new Error(`Image generation request ${status.requestId} failed`);
                }

                await this.delay(this.POLLING_INTERVAL_MS);
            } catch (error) {
                this.logger.error(`Error polling for image generation result: ${error}`);
                throw error;
            }
        }
    }

    /**
     * Helper method to simulate delay
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Submit request with retry logic
     */
    private async submitWithRetry(model: string, params: any, maxRetries: number = 3): Promise<any> {
        let lastError: any;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`Submitting request to ${model} (attempt ${attempt}/${maxRetries})`);
                return await fal.queue.submit(model, params);
            } catch (error: any) {
                lastError = error;
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                // Check if this is a retryable error
                const isRetryableError = this.isRetryableError(errorMessage);
                
                if (isRetryableError && attempt < maxRetries) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    this.logger.warn(`Retryable error on attempt ${attempt}: ${errorMessage}. Retrying in ${backoffDelay}ms`);
                    await this.delay(backoffDelay);
                } else {
                    this.logger.error(`Non-retryable error or max retries exceeded: ${errorMessage}`);
                    throw error;
                }
            }
        }
        
        throw lastError;
    }

    /**
     * Download image with retry logic
     */
    private async downloadImageWithRetry(imageUrl: string, outputPath: string, maxRetries: number = 3): Promise<void> {
        let lastError: any;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`Downloading image from ${imageUrl} (attempt ${attempt}/${maxRetries})`);
                const response = await fetch(imageUrl);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const buffer = await response.arrayBuffer();
                await fs.writeFile(outputPath, Buffer.from(buffer));
                this.logger.info(`Image downloaded successfully: ${outputPath}`);
                return;
            } catch (error: any) {
                lastError = error;
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                // Check if this is a retryable error
                const isRetryableError = this.isRetryableError(errorMessage);
                
                if (isRetryableError && attempt < maxRetries) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    this.logger.warn(`Retryable error downloading image on attempt ${attempt}: ${errorMessage}. Retrying in ${backoffDelay}ms`);
                    await this.delay(backoffDelay);
                } else {
                    this.logger.error(`Non-retryable error or max retries exceeded downloading image: ${errorMessage}`);
                    throw error;
                }
            }
        }
        
        throw lastError;
    }

    /**
     * Get status with retry logic
     */
    private async getStatusWithRetry(model: string, params: any, maxRetries: number = 3): Promise<any> {
        let lastError: any;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`Getting status for ${model} (attempt ${attempt}/${maxRetries})`);
                return await fal.queue.status(model, params);
            } catch (error: any) {
                lastError = error;
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                // Check if this is a retryable error
                const isRetryableError = this.isRetryableError(errorMessage);
                
                if (isRetryableError && attempt < maxRetries) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    this.logger.warn(`Retryable error getting status on attempt ${attempt}: ${errorMessage}. Retrying in ${backoffDelay}ms`);
                    await this.delay(backoffDelay);
                } else {
                    this.logger.error(`Non-retryable error or max retries exceeded getting status: ${errorMessage}`);
                    throw error;
                }
            }
        }
        
        throw lastError;
    }

    /**
     * Get result with retry logic
     */
    private async getResultWithRetry(model: string, params: any, maxRetries: number = 3): Promise<any> {
        let lastError: any;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`Getting result for ${model} (attempt ${attempt}/${maxRetries})`);
                return await fal.queue.result(model, params);
            } catch (error: any) {
                lastError = error;
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                // Check if this is a retryable error
                const isRetryableError = this.isRetryableError(errorMessage);
                
                if (isRetryableError && attempt < maxRetries) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    this.logger.warn(`Retryable error getting result on attempt ${attempt}: ${errorMessage}. Retrying in ${backoffDelay}ms`);
                    await this.delay(backoffDelay);
                } else {
                    this.logger.error(`Non-retryable error or max retries exceeded getting result: ${errorMessage}`);
                    throw error;
                }
            }
        }
        
        throw lastError;
    }

    /**
     * Check if an error is retryable
     */
    private isRetryableError(errorMessage: string): boolean {
        const retryablePatterns = [
            'fetch failed',
            'ECONNRESET',
            'ENOTFOUND',
            'ETIMEDOUT',
            'timeout',
            'Gateway Timeout',
            '504',
            '502',
            '503',
            'NetworkError',
            'TypeError: fetch failed'
        ];
        
        return retryablePatterns.some(pattern => 
            errorMessage.toLowerCase().includes(pattern.toLowerCase())
        );
    }

}

/* END GENAI */