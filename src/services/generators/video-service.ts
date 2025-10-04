import { fal } from "@fal-ai/client";
import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from '../../utils';

/**
 * Interface for video generation request status
 */
interface VideoGenerationStatus {
    requestId: string;
    status: "pending" | "in_progress" | "completed" | "failed";
    startTime: number;
}

/**
 * Service for generating videos from prompts and base images using fal.ai API
 */
export class VideoService {
    private logger: Logger;
    private readonly POLLING_INTERVAL_MS = 15000; // 15 seconds
    private readonly MAX_WAIT_TIME_MS = 900000; // 15 minutes
    private readonly VIDEO_MODEL = "fal-ai/minimax/hailuo-02/standard/image-to-video";
    // private readonly VIDEO_MODEL = "fal-ai/minimax/hailuo-02/pro/image-to-video"; //тут только 6 секунд

    constructor() {
        this.logger = new Logger();
    }

    /**
     * Generate a video from a prompt and base image, and save it to the specified path
     * @param prompt Text prompt for video generation
     * @param baseImagePath Path to the base image to use for video generation
     * @param outputPath Path where the generated video will be saved
     * @param duration Duration in seconds (6 or 10). Defaults to 6 if invalid.
     */
    public async generateVideo(
        prompt: string,
        baseImagePath: string,
        outputPath: string,
        duration?: number | string
    ): Promise<{ requestId: string, prompt: string } | void> {
        this.logger.info(`Generating video with prompt: ${prompt}`);
        this.logger.info(`Using base image: ${baseImagePath}`);
        this.logger.info(`Video will be saved to: ${outputPath}`);

        // Validate duration: must be 6 or 10, otherwise default to 6
        let durationStr = "6";
        if (duration === 6 || duration === "6") {
            durationStr = "6";
        } else if (duration === 10 || duration === "10") {
            durationStr = "10";
        }

        if (process.env.MOCK_API === 'true') {
            return this.mockGenerateVideo(prompt, baseImagePath, outputPath);
        }

        try {
            // Read base image file and convert to base64
            const imageBuffer = await fs.readFile(baseImagePath);
            const base64Image = `data:image/png;base64,${imageBuffer.toString('base64')}`;

            // Submit video generation request with retry
            const { request_id } = await this.submitWithRetry(this.VIDEO_MODEL, {
                input: {
                    prompt: prompt,
                    image_url: base64Image,
                    duration: durationStr,
                    prompt_optimizer: true
                }
            });

            this.logger.info(`Video generation request submitted with ID: ${request_id}`);

            const status: VideoGenerationStatus = {
                requestId: request_id,
                status: 'pending',
                startTime: Date.now()
            };

            // Poll for result
            const result = await this.pollForResult(status);

            if (result && result.data && result.data.video && result.data.video.url) {
                const videoUrl = result.data.video.url;
                const outputDir = path.dirname(outputPath);
                await fs.ensureDir(outputDir);

                // Download video with retry
                await this.downloadVideoWithRetry(videoUrl, outputPath);

                this.logger.info(`Video generated successfully: ${outputPath}`);
                return { requestId: request_id, prompt };
            } else {
                throw new Error('No video URL returned from the API');
            }
        } catch (error) {
            this.logger.error(`Error generating video: ${error}`);
            throw new Error(`Failed to generate video: ${error}`);
        }
    }

    /**
     * Poll for the result of a video generation request
     * @param status The status object for the request
     * @returns Promise resolving with the result when completed
     */
    private async pollForResult(status: VideoGenerationStatus): Promise<any> {
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;
        
        while (true) {
            try {
                const elapsedTime = Date.now() - status.startTime;
                if (elapsedTime > this.MAX_WAIT_TIME_MS) {
                    throw new Error(`Video generation timed out after ${this.MAX_WAIT_TIME_MS / 1000} seconds`);
                }

                const statusResponse = await this.getStatusWithRetry(this.VIDEO_MODEL, {
                    requestId: status.requestId,
                    logs: true
                });

                // Reset error counter on successful API call
                consecutiveErrors = 0;

                const apiStatus = statusResponse.status as string;

                if (apiStatus === 'COMPLETED') {
                    status.status = 'completed';
                } else if (apiStatus === 'FAILED') {
                    status.status = 'failed';
                } else if (apiStatus === 'IN_PROGRESS') {
                    status.status = 'in_progress';
                } else {
                    status.status = 'pending';
                }

                if ('logs' in statusResponse && Array.isArray(statusResponse.logs) && statusResponse.logs.length > 0) {
                    statusResponse.logs.forEach((log: { message: string }) => {
                        this.logger.info(`Video generation progress: ${log.message}`);
                    });
                }

                if (status.status === 'completed') {
                    this.logger.info(`Video generation request ${status.requestId} completed`);
                    return await this.getResultWithRetry(this.VIDEO_MODEL, { requestId: status.requestId });
                }

                if (status.status === 'failed') {
                    throw new Error(`Video generation request ${status.requestId} failed`);
                }

                await this.delay(this.POLLING_INTERVAL_MS);
            } catch (error) {
                consecutiveErrors++;
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                // Check if it's a timeout or gateway error that we should retry
                const isRetryableError = errorMessage.includes('504') || 
                                       errorMessage.includes('Gateway Timeout') ||
                                       errorMessage.includes('timeout') ||
                                       errorMessage.includes('ECONNRESET') ||
                                       errorMessage.includes('ENOTFOUND');
                
                if (isRetryableError && consecutiveErrors < maxConsecutiveErrors) {
                    const backoffDelay = this.POLLING_INTERVAL_MS * Math.pow(2, consecutiveErrors - 1);
                    this.logger.warn(`Retryable error (${consecutiveErrors}/${maxConsecutiveErrors}): ${errorMessage}. Retrying in ${backoffDelay}ms`);
                    await this.delay(backoffDelay);
                    continue;
                }
                
                this.logger.error(`Error polling for video generation result: ${errorMessage}`);
                throw error;
            }
        }
    }

    /**
     * Mock implementation of video generation for testing
     */
    private async mockGenerateVideo(prompt: string, baseImagePath: string, outputPath: string): Promise<void> {
        this.logger.info(`[MOCK] Generating video with prompt: ${prompt}`);
        try {
            const outputDir = path.dirname(outputPath);
            await fs.ensureDir(outputDir);
            await fs.writeFile(outputPath, `Mock video generated from prompt: ${prompt}\nBase image: ${baseImagePath}`);
            await this.delay(5000);
            this.logger.info(`[MOCK] Video generated successfully: ${outputPath}`);
        } catch (error) {
            this.logger.error(`[MOCK] Error generating video: ${error}`);
            throw new Error(`Failed to generate mock video: ${error}`);
        }
    }

    /**
     * Helper method to simulate delay
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
     * Download video with retry logic
     */
    private async downloadVideoWithRetry(videoUrl: string, outputPath: string, maxRetries: number = 3): Promise<void> {
        let lastError: any;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.logger.info(`Downloading video from ${videoUrl} (attempt ${attempt}/${maxRetries})`);
                const response = await fetch(videoUrl);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const buffer = await response.arrayBuffer();
                await fs.writeFile(outputPath, Buffer.from(buffer));
                this.logger.info(`Video downloaded successfully: ${outputPath}`);
                return;
            } catch (error: any) {
                lastError = error;
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                
                // Check if this is a retryable error
                const isRetryableError = this.isRetryableError(errorMessage);
                
                if (isRetryableError && attempt < maxRetries) {
                    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                    this.logger.warn(`Retryable error downloading video on attempt ${attempt}: ${errorMessage}. Retrying in ${backoffDelay}ms`);
                    await this.delay(backoffDelay);
                } else {
                    this.logger.error(`Non-retryable error or max retries exceeded downloading video: ${errorMessage}`);
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

    /**
     * Extract the last frame from a video and save it as an image
     * @param videoPath Path to the video file
     * @param outputPath Path where the extracted frame will be saved
     * @param offsetSeconds Seconds offset from end (default 0.05)
     */
    public async extractLastFrame(videoPath: string, outputPath: string, offsetSeconds: number = 0.2): Promise<void> {
        this.logger.info(`Extracting last frame from video: ${videoPath}`);
        this.logger.info(`Frame will be saved to: ${outputPath}`);

        if (process.env.MOCK_API === 'true') {
            return this.mockExtractLastFrame(videoPath, outputPath);
        }

        try {
            const duration = await this.getVideoDuration(videoPath);
            const timestamp = Math.max(0, duration - offsetSeconds);
            const outputDir = path.dirname(outputPath);
            await fs.ensureDir(outputDir);

            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                try {
                    await this.executeFrameExtraction(videoPath, outputPath, timestamp);
                    this.logger.info(`Frame extracted successfully: ${outputPath}`);
                    return;
                } catch (error) {
                    attempts++;
                    this.logger.warn(`Frame extraction attempt ${attempts} failed: ${error}`);
                    if (attempts >= maxAttempts) {
                        throw new Error(`Failed to extract frame after ${maxAttempts} attempts`);
                    }
                    await this.delay(2000 * attempts); // Exponential backoff
                }
            }
        } catch (error) {
            this.logger.error(`Error extracting frame: ${error}`);
            throw new Error(`Failed to extract frame: ${error}`);
        }
    }

    /**
     * Get the duration of a video file in seconds
     */
    private async getVideoDuration(videoPath: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                videoPath
            ]);

            let output = '';

            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`ffprobe process exited with code ${code}`));
                    return;
                }
                const duration = parseFloat(output.trim());
                if (isNaN(duration)) {
                    reject(new Error('Could not parse video duration'));
                    return;
                }
                resolve(duration);
            });

            ffprobe.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Execute the frame extraction using ffmpeg
     */
    private async executeFrameExtraction(videoPath: string, outputPath: string, timestamp: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-ss', timestamp.toString(),
                '-i', videoPath,
                '-frames:v', '1',
                '-q:v', '2',
                '-y',
                outputPath
            ]);

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`ffmpeg process exited with code ${code}`));
                    return;
                }
                resolve();
            });

            ffmpeg.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Mock implementation of frame extraction for testing
     */
    private async mockExtractLastFrame(videoPath: string, outputPath: string): Promise<void> {
        this.logger.info(`[MOCK] Extracting last frame from video: ${videoPath}`);
        try {
            const outputDir = path.dirname(outputPath);
            await fs.ensureDir(outputDir);
            await fs.writeFile(outputPath, `Mock frame extracted from video: ${videoPath}`);
            await this.delay(2000);
            this.logger.info(`[MOCK] Frame extracted successfully: ${outputPath}`);
        } catch (error) {
            this.logger.error(`[MOCK] Error extracting frame: ${error}`);
            throw new Error(`Failed to extract mock frame: ${error}`);
        }
    }
}