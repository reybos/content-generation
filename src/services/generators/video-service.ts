import { fal } from "@fal-ai/client";
import * as fs from 'fs-extra';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger, validatePromptLength } from '../../utils';
import { ContentType, WorkerConfig } from '../../types';
import { FileService } from '../core/file-service';

/**
 * Interface for video generation request status
 */
interface VideoGenerationStatus {
    requestId: string;
    status: "pending" | "in_progress" | "completed" | "failed";
    startTime: number;
}

export interface VideoGenerationTask {
    imagePath: string;
    prompt: string;
    outputPath: string;
    duration: number;
    index: number | string; // Display index for logging and metadata
}

export interface VideoGenerationResult {
    index: number | string;
    success: boolean;
    error?: string;
}

/**
 * Service for generating videos from prompts and base images using fal.ai API
 */
export class VideoService {
    private logger: Logger;
    private fileService: FileService;
    private readonly POLLING_INTERVAL_MS = 15000; // 15 seconds
    private readonly MAX_WAIT_TIME_MS = 900000; // 15 minutes
    private readonly VIDEO_MODEL: string;
    private readonly BATCH_SIZE: number;
    private readonly MAX_PROMPT_LENGTH = 1950;
    private readonly MAIN_VIDEO_DURATION: number;
    private readonly ADDITIONAL_SCENE_DURATION: number;

    constructor(config?: Partial<WorkerConfig>) {
        this.logger = new Logger();
        this.fileService = new FileService();
        this.VIDEO_MODEL = config?.videoModel ?? "fal-ai/minimax/hailuo-02/standard/image-to-video";
        this.BATCH_SIZE = config?.batchSize ?? 12;
        this.MAIN_VIDEO_DURATION = config?.mainVideoDuration ?? 6;
        this.ADDITIONAL_SCENE_DURATION = config?.additionalSceneDuration ?? 10;
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
     * Prepare video generation tasks based on content type
     */
    public async prepareVideoTasks(
        contentType: ContentType,
        folderPath: string
    ): Promise<{ sceneTasks: VideoGenerationTask[]; groupFrameTasks?: VideoGenerationTask[]; additionalFrameTasks?: VideoGenerationTask[] }> {
        switch (contentType) {
            case ContentType.HALLOWEEN:
                return this.prepareHalloweenTasks(folderPath);
            case ContentType.POEMS:
                return this.preparePoemsTasks(folderPath);
            case ContentType.POEMS_DIRECT_VIDEO:
                const blankVideoPath = path.join(folderPath, 'blank-video.png');
                return this.prepareDirectVideoTasks(folderPath, blankVideoPath);
            default:
                throw new Error(`No handler for content type: ${contentType}`);
        }
    }

    /**
     * Prepare Halloween video generation tasks
     */
    private async prepareHalloweenTasks(folderPath: string): Promise<{ sceneTasks: VideoGenerationTask[]; groupFrameTasks: VideoGenerationTask[] }> {
        // Read files in folder
        const files = await fs.readdir(folderPath);
        
        // Find JSON file
        const jsonFile = files.find((file) => file.endsWith(".json"));
        if (!jsonFile) {
            throw new Error("No JSON file found");
        }

        // Read JSON data
        const jsonFilePath = path.join(folderPath, jsonFile);
        const data = await this.fileService.readFile(jsonFilePath);
        const newFormatData = data as any;

        // Check if video_prompts exist
        if (!newFormatData.video_prompts || !Array.isArray(newFormatData.video_prompts) || newFormatData.video_prompts.length === 0) {
            throw new Error("No video_prompts found in JSON file");
        }

        // Count scene images
        const sceneImages = files.filter(file => file.match(/^scene_\d+\.png$/));
        
        // Check scene images count matches video_prompts count
        if (newFormatData.video_prompts.length !== sceneImages.length) {
            throw new Error(`Mismatch between video_prompts count (${newFormatData.video_prompts.length}) and scene images count (${sceneImages.length})`);
        }

        // Prepare tasks for main scenes
        const sceneTasks: VideoGenerationTask[] = [];
        for (let i = 0; i < newFormatData.video_prompts.length; i++) {
            const videoPrompt = newFormatData.video_prompts[i];
            if (!videoPrompt.video_prompt) {
                throw new Error(`Missing video_prompt at index ${i}`);
            }
            
            // Use videoPrompt.index if available, otherwise use array index i
            const index = videoPrompt.index ?? i;
            
            // Validate prompt length
            const promptValidation = validatePromptLength(videoPrompt.video_prompt, this.MAX_PROMPT_LENGTH);
            if (!promptValidation.isValid) {
                throw new Error(`Scene ${index}: ${promptValidation.error}`);
            }
            
            // Check if image exists for this index
            const imagePath = path.join(folderPath, `scene_${index}.png`);
            if (!await fs.pathExists(imagePath)) {
                this.logger.warn(`Image file not found for scene ${index}: ${imagePath}, skipping video generation`);
                continue;
            }
            
            sceneTasks.push({
                imagePath: imagePath,
                prompt: videoPrompt.video_prompt,
                outputPath: path.join(folderPath, `scene_${index}.mp4`),
                duration: this.MAIN_VIDEO_DURATION,
                index: index
            });
        }

        // Process group frames if they exist
        const groupFramesCount = newFormatData.group_frames ? newFormatData.group_frames.length : 0;
        const groupFrameTasks: VideoGenerationTask[] = [];
        
        if (groupFramesCount > 0) {
            const groupFrameImages = files.filter(file => file.match(/^group_frame_\d+\.png$/));
            
            // Check group frame images count matches group_frames count
            if (groupFrameImages.length !== groupFramesCount) {
                throw new Error(`Mismatch between group_frames count (${groupFramesCount}) and group frame images count (${groupFrameImages.length})`);
            }

            // Prepare tasks for group frames
            for (let i = 0; i < groupFramesCount; i++) {
                const frame = newFormatData.group_frames[i];
                if (!frame.group_video_prompt) {
                    throw new Error(`Missing group_video_prompt for group frame at index ${i}`);
                }
                
                // Validate prompt length
                const promptValidation = validatePromptLength(frame.group_video_prompt, this.MAX_PROMPT_LENGTH);
                if (!promptValidation.isValid) {
                    throw new Error(`Group frame ${frame.index}: ${promptValidation.error}`);
                }
                
                groupFrameTasks.push({
                    imagePath: path.join(folderPath, `group_frame_${frame.index}.png`),
                    prompt: frame.group_video_prompt,
                    outputPath: path.join(folderPath, `group_frame_${frame.index}.mp4`),
                    duration: this.ADDITIONAL_SCENE_DURATION,
                    index: `group_frame_${frame.index}`
                });
            }
        }

        return { sceneTasks, groupFrameTasks };
    }

    /**
     * Prepare Poems video generation tasks
     */
    private async preparePoemsTasks(folderPath: string): Promise<{ sceneTasks: VideoGenerationTask[]; additionalFrameTasks: VideoGenerationTask[] }> {
        // Read files in folder
        const files = await fs.readdir(folderPath);
        
        // Find JSON file
        const jsonFile = files.find((file) => file.endsWith(".json"));
        if (!jsonFile) {
            throw new Error("No JSON file found");
        }

        // Read JSON data
        const jsonFilePath = path.join(folderPath, jsonFile);
        const data = await this.fileService.readFile(jsonFilePath);
        const newFormatData = data as any;

        // Check if video_prompts exist
        if (!newFormatData.video_prompts || !Array.isArray(newFormatData.video_prompts) || newFormatData.video_prompts.length === 0) {
            throw new Error("No video_prompts found in JSON file");
        }

        // Count scene images
        const sceneImages = files.filter(file => file.match(/^scene_\d+\.png$/));
        
        // Check scene images count matches video_prompts count
        if (newFormatData.video_prompts.length !== sceneImages.length) {
            throw new Error(`Mismatch between video_prompts count (${newFormatData.video_prompts.length}) and scene images count (${sceneImages.length})`);
        }

        // Prepare tasks for main scenes
        const sceneTasks: VideoGenerationTask[] = [];
        for (let i = 0; i < newFormatData.video_prompts.length; i++) {
            const videoPrompt = newFormatData.video_prompts[i];
            if (!videoPrompt.video_prompt) {
                throw new Error(`Missing video_prompt at index ${i}`);
            }
            
            // Use videoPrompt.index if available, otherwise use array index i
            const index = videoPrompt.index ?? i;
            
            // Validate prompt length
            const promptValidation = validatePromptLength(videoPrompt.video_prompt, this.MAX_PROMPT_LENGTH);
            if (!promptValidation.isValid) {
                throw new Error(`Scene ${index}: ${promptValidation.error}`);
            }
            
            // Check if image exists for this index
            const imagePath = path.join(folderPath, `scene_${index}.png`);
            if (!await fs.pathExists(imagePath)) {
                this.logger.warn(`Image file not found for scene ${index}: ${imagePath}, skipping video generation`);
                continue;
            }
            
            sceneTasks.push({
                imagePath: imagePath,
                prompt: videoPrompt.video_prompt,
                outputPath: path.join(folderPath, `scene_${index}.mp4`),
                duration: this.MAIN_VIDEO_DURATION,
                index: index
            });
        }

        // Process additional frames if they exist
        const additionalFramesCount = newFormatData.additional_frames ? newFormatData.additional_frames.length : 0;
        const additionalFrameTasks: VideoGenerationTask[] = [];
        
        if (additionalFramesCount > 0) {
            // Check for additional_frame images
            const additionalFrameImages = files.filter(file => file.match(/^additional_frame_\d+\.png$/));
            
            // Check additional frame images count matches additional_frames count
            if (additionalFrameImages.length !== additionalFramesCount) {
                throw new Error(`Mismatch between additional_frames count (${additionalFramesCount}) and additional frame images count (${additionalFrameImages.length})`);
            }

            // Prepare tasks for additional frames
            for (let i = 0; i < additionalFramesCount; i++) {
                const frame = newFormatData.additional_frames[i];
                if (!frame.video_prompt) {
                    throw new Error(`Missing video_prompt for additional frame at index ${frame.index}`);
                }
                
                // Validate prompt length
                const promptValidation = validatePromptLength(frame.video_prompt, this.MAX_PROMPT_LENGTH);
                if (!promptValidation.isValid) {
                    throw new Error(`Additional frame ${frame.index}: ${promptValidation.error}`);
                }
                
                additionalFrameTasks.push({
                    imagePath: path.join(folderPath, `additional_frame_${frame.index}.png`),
                    prompt: frame.video_prompt,
                    outputPath: path.join(folderPath, `additional_frame_${frame.index}.mp4`),
                    duration: this.ADDITIONAL_SCENE_DURATION,
                    index: `additional_frame_${frame.index}`
                });
            }
        }

        return { sceneTasks, additionalFrameTasks };
    }

    /**
     * Prepare direct video generation tasks for poems-direct-video files
     * Uses blank-video.png as base image for all videos
     */
    public async prepareDirectVideoTasks(
        folderPath: string,
        blankVideoPath: string
    ): Promise<{ sceneTasks: VideoGenerationTask[]; groupFrameTasks: VideoGenerationTask[]; additionalFrameTasks: VideoGenerationTask[] }> {
        // Read files in folder
        const files = await fs.readdir(folderPath);
        
        // Find JSON file
        const jsonFile = files.find((file) => file.endsWith(".json"));
        if (!jsonFile) {
            throw new Error("No JSON file found");
        }

        // Read JSON data
        const jsonFilePath = path.join(folderPath, jsonFile);
        const data = await this.fileService.readFile(jsonFilePath);
        const newFormatData = data as any;

        // Check if video_prompts exist
        if (!newFormatData.video_prompts || !Array.isArray(newFormatData.video_prompts) || newFormatData.video_prompts.length === 0) {
            throw new Error("No video_prompts found in JSON file");
        }

        // Verify blank-video.png exists
        if (!await fs.pathExists(blankVideoPath)) {
            throw new Error(`blank-video.png not found at ${blankVideoPath}`);
        }

        // Prepare tasks for main scenes using blank-video.png as base image
        const sceneTasks: VideoGenerationTask[] = [];
        for (let i = 0; i < newFormatData.video_prompts.length; i++) {
            const videoPrompt = newFormatData.video_prompts[i];
            if (!videoPrompt.video_prompt) {
                throw new Error(`Missing video_prompt at index ${i}`);
            }
            
            // Validate prompt length
            const promptValidation = validatePromptLength(videoPrompt.video_prompt, this.MAX_PROMPT_LENGTH);
            if (!promptValidation.isValid) {
                throw new Error(`Scene ${i}: ${promptValidation.error}`);
            }
            
            sceneTasks.push({
                imagePath: blankVideoPath,
                prompt: videoPrompt.video_prompt,
                outputPath: path.join(folderPath, `scene_${i}.mp4`),
                duration: this.MAIN_VIDEO_DURATION,
                index: i
            });
        }

        // Process group frames if they exist
        const groupFramesCount = newFormatData.group_frames ? newFormatData.group_frames.length : 0;
        const groupFrameTasks: VideoGenerationTask[] = [];
        
        if (groupFramesCount > 0) {
            // Prepare tasks for group frames using blank-video.png as base image
            for (let i = 0; i < groupFramesCount; i++) {
                const frame = newFormatData.group_frames[i];
                if (!frame.group_video_prompt) {
                    throw new Error(`Missing group_video_prompt for group frame at index ${i}`);
                }
                
                // Validate prompt length
                const promptValidation = validatePromptLength(frame.group_video_prompt, this.MAX_PROMPT_LENGTH);
                if (!promptValidation.isValid) {
                    throw new Error(`Group frame ${frame.index}: ${promptValidation.error}`);
                }
                
                groupFrameTasks.push({
                    imagePath: blankVideoPath,
                    prompt: frame.group_video_prompt,
                    outputPath: path.join(folderPath, `group_frame_${frame.index}.mp4`),
                    duration: this.ADDITIONAL_SCENE_DURATION,
                    index: `group_frame_${frame.index}`
                });
            }
        }

        // Process additional frames if they exist (for POEMS_DIRECT_VIDEO, generate directly from video_prompt)
        const additionalFramesCount = newFormatData.additional_frames ? newFormatData.additional_frames.length : 0;
        const additionalFrameTasks: VideoGenerationTask[] = [];
        
        if (additionalFramesCount > 0) {
            // Prepare tasks for additional frames using blank-video.png as base image
            for (let i = 0; i < additionalFramesCount; i++) {
                const frame = newFormatData.additional_frames[i];
                if (!frame.video_prompt) {
                    throw new Error(`Missing video_prompt for additional frame at index ${frame.index}`);
                }
                
                // Validate prompt length
                const promptValidation = validatePromptLength(frame.video_prompt, this.MAX_PROMPT_LENGTH);
                if (!promptValidation.isValid) {
                    throw new Error(`Additional frame ${frame.index}: ${promptValidation.error}`);
                }
                
                additionalFrameTasks.push({
                    imagePath: blankVideoPath,
                    prompt: frame.video_prompt,
                    outputPath: path.join(folderPath, `additional_frame_${frame.index}.mp4`),
                    duration: this.ADDITIONAL_SCENE_DURATION,
                    index: `additional_frame_${frame.index}`
                });
            }
        }

        return { sceneTasks, groupFrameTasks, additionalFrameTasks };
    }

    /**
     * Generate a batch of videos
     */
    public async generateVideoBatch(
        tasks: VideoGenerationTask[],
        folderPath: string,
        type: 'scene' | 'group_frame' | 'additional_frame'
    ): Promise<VideoGenerationResult[]> {
        const allErrors: Array<{ type: string; index: number | string; error: string }> = [];
        const allResults: VideoGenerationResult[] = [];
        
        // Filter out tasks where video already exists
        const tasksToProcess: VideoGenerationTask[] = [];
        for (const task of tasks) {
            if (await fs.pathExists(task.outputPath)) {
                this.logger.info(`Video already exists for ${type} ${task.index}, skipping`);
                allResults.push({ index: task.index, success: true });
            } else {
                // Check if image exists
                if (!await fs.pathExists(task.imagePath)) {
                    const error = `Image file not found: ${task.imagePath}`;
                    allErrors.push({ type, index: task.index, error });
                    allResults.push({ index: task.index, success: false, error });
                } else {
                    tasksToProcess.push(task);
                }
            }
        }

        if (tasksToProcess.length === 0) {
            return allResults;
        }

        this.logger.info(`Starting batch video generation: ${tasksToProcess.length} videos in batches of ${this.BATCH_SIZE}`);
        
        // Process in batches
        for (let batchStart = 0; batchStart < tasksToProcess.length; batchStart += this.BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + this.BATCH_SIZE, tasksToProcess.length);
            const currentBatch = batchEnd - batchStart;
            
            this.logger.info(`Processing batch ${Math.floor(batchStart / this.BATCH_SIZE) + 1}: ${batchStart} to ${batchEnd - 1} (${currentBatch} videos)`);
            
            const videoPromises = [];
            
            for (let i = batchStart; i < batchEnd; i++) {
                const task = tasksToProcess[i];
                
                this.logger.info(`Adding ${type} ${task.index} to batch for video generation`);
                
                const videoPromise = this.generateVideo(
                    task.prompt,
                    task.imagePath,
                    task.outputPath,
                    task.duration
                ).then(async (videoResult) => {
                    // Save video metadata
                    await this.saveVideoMeta(folderPath, task.index, videoResult);
                    this.logger.info(`Successfully generated video for ${type} ${task.index}`);
                    return { index: task.index, success: true };
                }).catch(async (error) => {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    this.logger.error(`Failed to generate video for ${type} ${task.index}: ${errorMessage}`);
                    allErrors.push({ type, index: task.index, error: errorMessage });
                    return { index: task.index, success: false, error: errorMessage };
                });
                
                videoPromises.push(videoPromise);
            }
            
            // Wait for current batch to complete
            if (videoPromises.length > 0) {
                const batchResults = await Promise.all(videoPromises);
                allResults.push(...batchResults);
                
                // Log batch results
                const successfulCount = batchResults.filter(r => r.success).length;
                this.logger.info(`Batch ${Math.floor(batchStart / this.BATCH_SIZE) + 1} completed: ${successfulCount}/${currentBatch} videos generated successfully`);
                
                // Log failed generations but don't throw error
                const failedResults = batchResults.filter(r => !r.success) as Array<{ index: number | string; success: boolean; error: string }>;
                if (failedResults.length > 0) {
                    this.logger.warn(`Some videos failed in batch ${Math.floor(batchStart / this.BATCH_SIZE) + 1}:`);
                    failedResults.forEach(result => {
                        this.logger.warn(`  ${type} ${result.index}: ❌ Failed - ${result.error}`);
                    });
                }
            }
        }
        
        return allResults;
    }

    /**
     * Save video metadata to meta.json file
     */
    public async saveVideoMeta(folderPath: string, scene: number | string, videoResult: any): Promise<void> {
        const metaPath = path.join(folderPath, 'meta.json');
        let metaArr = [];
        if (await fs.pathExists(metaPath)) {
            metaArr = await fs.readJson(metaPath);
        }
        let sceneMeta = metaArr.find((m: any) => m.scene === scene);
        if (!sceneMeta) {
            sceneMeta = { scene };
            metaArr.push(sceneMeta);
        }
        sceneMeta.video = videoResult;
        await fs.writeJson(metaPath, metaArr, { spaces: 2 });
    }

}