/* START GENAI */

import { fal } from '@fal-ai/client';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '../utils';

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
    private readonly IMAGE_MODEL = 'fal-ai/minimax/image-01';

    /**
     * Create a new ImageService instance
     */
    constructor() {
        this.logger = new Logger();
    }

    /**
     * Generate an image from a prompt and save it to the specified path
     */
    public async generateImage(prompt: string, outputPath: string): Promise<{ requestId: string, prompt: string } | void> {
        this.logger.info(`Generating image with prompt: ${prompt}`);
        this.logger.info(`Image will be saved to: ${outputPath}`);

        // Mock mode
        if (process.env.MOCK_API === 'true') {
            return this.mockGenerateImage(prompt, outputPath);
        }

        try {
            const { request_id } = await fal.queue.submit(this.IMAGE_MODEL, {
                input: {
                    prompt,
                    // aspect_ratio: '9:16',
                    aspect_ratio: '16:9',
                    num_images: 1,
                },
            });

            this.logger.info(`Image generation request submitted with ID: ${request_id}`);

            const status: ImageGenerationStatus = {
                requestId: request_id,
                status: 'pending',
                startTime: Date.now(),
            };

            const result = await this.pollForResult(status);

            if (
                result &&
                result.data &&
                Array.isArray(result.data.images) &&
                result.data.images.length > 0
            ) {
                const imageUrl = result.data.images[0].url;
                const outputDir = path.dirname(outputPath);

                await fs.ensureDir(outputDir);

                const response = await fetch(imageUrl);
                const buffer = await response.arrayBuffer();
                await fs.writeFile(outputPath, Buffer.from(buffer));

                this.logger.info(`Image generated successfully: ${outputPath}`);
                return { requestId: request_id, prompt };
            } else {
                throw new Error('No images returned from the API');
            }
        } catch (error) {
            this.logger.error(`Error generating image: ${error}`);
            throw new Error(`Failed to generate image: ${error}`);
        }
    }

    /**
     * Poll for the result of an image generation request
     */
    private async pollForResult(status: ImageGenerationStatus): Promise<any> {
        while (true) {
            try {
                const elapsedTime = Date.now() - status.startTime;
                if (elapsedTime > this.MAX_WAIT_TIME_MS) {
                    throw new Error(
                        `Image generation timed out after ${this.MAX_WAIT_TIME_MS / 1000} seconds`
                    );
                }

                const statusResponse = await fal.queue.status(this.IMAGE_MODEL, {
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
                    return await fal.queue.result(this.IMAGE_MODEL, {
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
     * Mock implementation of image generation for testing
     */
    private async mockGenerateImage(prompt: string, outputPath: string): Promise<void> {
        this.logger.info(`[MOCK] Generating image with prompt: ${prompt}`);

        try {
            const outputDir = path.dirname(outputPath);
            await fs.ensureDir(outputDir);
            await fs.writeFile(outputPath, `Mock image generated from prompt: ${prompt}`);
            await this.delay(5000); // Simulate API call delay
            this.logger.info(`[MOCK] Image generated successfully: ${outputPath}`);
        } catch (error) {
            this.logger.error(`[MOCK] Error generating image: ${error}`);
            throw new Error(`Failed to generate mock image: ${error}`);
        }
    }
}

/* END GENAI */