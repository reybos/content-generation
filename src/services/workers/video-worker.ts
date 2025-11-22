import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { StateService } from '../core/state-service';
import { VideoService } from '../generators/video-service';
import { Logger, isHalloweenFile, validatePromptLength } from '../../utils';
import { ContentType } from '../../types';
import * as path from 'path';
import * as fs from 'fs-extra';

interface VideoGenerationTask {
    imagePath: string;
    prompt: string;
    outputPath: string;
    duration: number;
    index: number | string; // Display index for logging and metadata
}

interface VideoGenerationResult {
    index: number | string;
    success: boolean;
    error?: string;
}

export class VideoWorker {
    private fileService = new FileService();
    private videoService = new VideoService();
    private lockService = new LockService();
    private stateService = new StateService();
    private logger = new Logger();
    private maxRetries = 5;
    private readonly BATCH_SIZE = 12;
    private readonly MAX_PROMPT_LENGTH = 1950;

    public async start(): Promise<void> {
        this.logger.info("Starting video generation worker");
        
        while (true) {
            try {
                // Look for folders in unprocessed for video processing
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                
                // Find first folder of any known type (only by name, structure check happens inside)
                const folderMatch = this.findFolderByType(unprocessedFolders);
                if (folderMatch) {
                    this.logger.info(`Found ${folderMatch.type} folder for video generation: ${path.basename(folderMatch.folder)}`);
                    await this.processFolder(folderMatch.folder, folderMatch.type);
                    continue;
                }

                // No files or folders to process, wait
                this.logger.info('No files or folders to process, waiting...');
                await this.sleep(25000 + Math.floor(Math.random() * 5000));
            } catch (error) {
                this.logger.error("Error in video worker loop", error);
                await this.sleep(10000);
            }
        }
    }


    private findFolderByType(folders: string[]): { folder: string; type: ContentType } | null {
        // Check folders in priority order
        for (const folder of folders) {
            const folderName = path.basename(folder);
            
            // Check Halloween pattern (only name, no structure check)
            if (isHalloweenFile(folderName)) {
                return { folder, type: ContentType.HALLOWEEN };
            }
            
            // Future: add checks for other types
            // if (isChristmasFile(folderName)) {
            //     return { folder, type: ContentType.CHRISTMAS };
            // }
        }
        
        return null;
    }

    private async prepareHalloweenTasks(folderPath: string): Promise<{ sceneTasks: VideoGenerationTask[]; additionalFrameTasks: VideoGenerationTask[] }> {
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
            
            // Validate prompt length
            const promptValidation = validatePromptLength(videoPrompt.video_prompt, this.MAX_PROMPT_LENGTH);
            if (!promptValidation.isValid) {
                throw new Error(`Scene ${i}: ${promptValidation.error}`);
            }
            
            sceneTasks.push({
                imagePath: path.join(folderPath, `scene_${i}.png`),
                prompt: videoPrompt.video_prompt,
                outputPath: path.join(folderPath, `scene_${i}.mp4`),
                duration: 6,
                index: i
            });
        }

        // Process additional frames if they exist
        const additionalFramesCount = newFormatData.additional_frames ? newFormatData.additional_frames.length : 0;
        const additionalFrameTasks: VideoGenerationTask[] = [];
        
        if (additionalFramesCount > 0) {
            const additionalFrameImages = files.filter(file => file.match(/^additional_frame_\d+\.png$/));
            
            // Check additional frame images count matches additional_frames count
            if (additionalFrameImages.length !== additionalFramesCount) {
                throw new Error(`Mismatch between additional_frames count (${additionalFramesCount}) and additional frame images count (${additionalFrameImages.length})`);
            }

            // Prepare tasks for additional frames
            for (let i = 0; i < additionalFramesCount; i++) {
                const frame = newFormatData.additional_frames[i];
                if (!frame.group_video_prompt) {
                    throw new Error(`Missing group_video_prompt for additional frame at index ${i}`);
                }
                
                // Validate prompt length
                const promptValidation = validatePromptLength(frame.group_video_prompt, this.MAX_PROMPT_LENGTH);
                if (!promptValidation.isValid) {
                    throw new Error(`Additional frame ${frame.index}: ${promptValidation.error}`);
                }
                
                additionalFrameTasks.push({
                    imagePath: path.join(folderPath, `additional_frame_${frame.index}.png`),
                    prompt: frame.group_video_prompt,
                    outputPath: path.join(folderPath, `additional_frame_${frame.index}.mp4`),
                    duration: 10,
                    index: `additional_frame_${frame.index}`
                });
            }
        }

        return { sceneTasks, additionalFrameTasks };
    }

    private async generateVideoBatch(
        tasks: VideoGenerationTask[],
        folderPath: string,
        type: 'scene' | 'additional_frame'
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
                
                const videoPromise = this.videoService.generateVideo(
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

    private async processFolder(folderPath: string, folderType: ContentType): Promise<void> {
        const folderName = path.basename(folderPath);
        const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);
        let lockReleased = false;

        try {
            // Move folder to in-progress
            await fs.move(folderPath, inProgressPath, { overwrite: true });
            this.logger.info(`Processing ${folderType} folder: ${inProgressPath}`);

            // Acquire lock
            const lockAcquired = await this.lockService.acquireLock(inProgressPath);
            if (!lockAcquired) {
                this.logger.info(`Could not acquire lock for ${inProgressPath}, skipping`);
                return;
            }

            // Initialize state
            const state = await this.stateService.initializeState(
                inProgressPath,
                this.lockService.getWorkerId(),
                this.maxRetries
            );

            // Check if max retries exceeded
            if (await this.stateService.hasExceededMaxRetries(inProgressPath)) {
                if (await this.stateService.isInCooldown(inProgressPath)) {
                    this.logger.info(`Folder ${inProgressPath} is in cooldown period, skipping`);
                    return;
                }

                const failedAttempts = state.failedAttempts || 0;
                const baseDelay = 60000;
                const maxDelay = 3600000;
                const cooldownTime = Math.min(baseDelay * Math.pow(2, failedAttempts), maxDelay);

                this.logger.warn(`Max retries exceeded for ${inProgressPath}, marking as failed with ${cooldownTime/1000}s cooldown`);
                await this.stateService.markFailed(inProgressPath, "Max retries exceeded", cooldownTime);
                await this.fileService.moveFailedFolder(folderName);
                return;
            }

            // Prepare tasks (type-specific)
            let sceneTasks: VideoGenerationTask[] = [];
            let additionalFrameTasks: VideoGenerationTask[] = [];
            
            switch (folderType) {
                case ContentType.HALLOWEEN:
                    const tasks = await this.prepareHalloweenTasks(inProgressPath);
                    sceneTasks = tasks.sceneTasks;
                    additionalFrameTasks = tasks.additionalFrameTasks;
                    break;
                // Future: add cases for other types
                // case ContentType.CHRISTMAS:
                //     const christmasTasks = await this.prepareChristmasTasks(inProgressPath);
                //     sceneTasks = christmasTasks.sceneTasks;
                //     additionalFrameTasks = christmasTasks.additionalFrameTasks;
                //     break;
                default:
                    throw new Error(`No handler for folder type: ${folderType}`);
            }

            // Process videos (common logic for all types)
            await this.processVideos(inProgressPath, sceneTasks, additionalFrameTasks);

            // Move to processed
            await this.fileService.moveProcessedFolder(folderName);
            this.logger.info(`Successfully processed folder: ${folderName}`);
            
        } catch (error) {
            this.logger.error(`Error processing folder ${inProgressPath}:`, error);
            
            try {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                await this.stateService.markFailed(inProgressPath, errorMessage);
                await this.fileService.moveFailedFolder(folderName);
            } catch (stateError) {
                this.logger.error(`Error updating state for ${inProgressPath}`, stateError);
                // In case of error, try to move to failed
                try {
                    await this.fileService.moveFailedFolder(folderName);
                } catch (moveError) {
                    this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
                    // If we can't move to failed, at least try to clean up the in-progress folder
                    try {
                        const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);
                        if (await fs.pathExists(inProgressPath)) {
                            await fs.remove(inProgressPath);
                            this.logger.info(`Cleaned up in-progress folder: ${inProgressPath}`);
                        }
                    } catch (cleanupError) {
                        this.logger.error(`Failed to cleanup in-progress folder: ${folderName}`, cleanupError);
                    }
                }
            }
        } finally {
            try {
                if (!lockReleased) {
                    await this.lockService.releaseLock(inProgressPath);
                    lockReleased = true;
                    this.logger.info(`Lock released for ${inProgressPath}`);
                }
            } catch (lockError) {
                this.logger.warn(`Error releasing lock for ${inProgressPath}:`, lockError);
            }
        }
    }

    private async processVideos(
        folderPath: string,
        sceneTasks: VideoGenerationTask[],
        additionalFrameTasks: VideoGenerationTask[]
    ): Promise<void> {
        this.logger.info(`Found ${sceneTasks.length} video prompts and scene images`);
        if (additionalFrameTasks.length > 0) {
            this.logger.info(`Found ${additionalFrameTasks.length} additional frames`);
        }

        // Generate videos for main scenes
        const sceneResults = await this.generateVideoBatch(
            sceneTasks,
            folderPath,
            'scene'
        );

        // Generate videos for additional frames if they exist
        let additionalFrameResults: VideoGenerationResult[] = [];
        if (additionalFrameTasks.length > 0) {
            additionalFrameResults = await this.generateVideoBatch(
                additionalFrameTasks,
                folderPath,
                'additional_frame'
            );
        }

        // Collect all errors
        const allErrors = [...sceneResults, ...additionalFrameResults].filter(r => !r.success);
        
        // Make a decision about the folder's fate based on collected errors
        if (allErrors.length > 0) {
            this.logger.warn(`Video generation completed with ${allErrors.length} errors:`);
            allErrors.forEach(result => {
                this.logger.warn(`  ${result.index}: ❌ Failed - ${result.error}`);
            });
            
            // If there are errors, throw to trigger folder movement to failed
            throw new Error(`Video generation failed with ${allErrors.length} errors`);
        } else {
            this.logger.info(`All videos generated successfully, marking as completed`);
            await this.stateService.markCompleted(folderPath);
        }
    }

    private async saveVideoMeta(folderPath: string, scene: number | string, videoResult: any): Promise<void> {
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

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

}
