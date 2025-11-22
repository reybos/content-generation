import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { StateService } from '../core/state-service';
import { VideoService } from '../generators/video-service';
import { Logger } from '../../utils';
import * as path from 'path';
import * as fs from 'fs-extra';

export class VideoWorker {
    private fileService = new FileService();
    private videoService = new VideoService();
    private lockService = new LockService();
    private stateService = new StateService();
    private logger = new Logger();
    private maxRetries = 5;

    public async start(): Promise<void> {
        this.logger.info("Starting video generation worker");
        
        while (true) {
            try {
                // Look for folders in unprocessed for video processing (existing formats)
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                
                // 1. Priority: song with scene_*.png images
                const foldersWithScenes = this.findFoldersWithScenes(unprocessedFolders);
                if (foldersWithScenes.length > 0) {
                    this.logger.info(`Found ${foldersWithScenes.length} song with animal folders for video generation`);
                    await this.processFolderWithScenes(foldersWithScenes[0]);
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

    private findFoldersWithScenes(folders: string[]): string[] {
        return folders.filter(folder => {
            try {
                const files = fs.readdirSync(folder);
                const hasJson = files.some(f => f.endsWith('.json'));
                const hasSceneImages = files.some(f => f.match(/^scene_\d+\.png$/));
                return hasJson && hasSceneImages;
            } catch {
                return false;
            }
        });
    }

    private async processFolderWithScenes(folderPath: string): Promise<void> {
        const folderName = path.basename(folderPath);
        const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);

        try {
            // Move folder to in-progress
            await fs.move(folderPath, inProgressPath, { overwrite: true });
            this.logger.info(`Processing song with animal folder: ${inProgressPath}`);
            
            await this.processScenesVideoGeneration(inProgressPath);
            
            // Move to processed
            await this.fileService.moveProcessedFolder(folderName);
            this.logger.info(`Successfully processed song with animal folder: ${folderName}`);
            
        } catch (error) {
            this.logger.error(`Error processing song with animal folder ${inProgressPath}:`, error);
            
            // In case of error, move to failed
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
    }

    private async processScenesVideoGeneration(folderPath: string): Promise<void> {
        let lockReleased = false;
        
        try {
            const lockAcquired = await this.lockService.acquireLock(folderPath);
            if (!lockAcquired) {
                this.logger.info(`Could not acquire lock for ${folderPath}, skipping`);
                return;
            }

            // Initialize state
            const state = await this.stateService.initializeState(
                folderPath,
                this.lockService.getWorkerId(),
                this.maxRetries
            );

            // Check if max retries exceeded
            if (await this.stateService.hasExceededMaxRetries(folderPath)) {
                if (await this.stateService.isInCooldown(folderPath)) {
                    this.logger.info(`Folder ${folderPath} is in cooldown period, skipping`);
                    return;
                }

                const failedAttempts = state.failedAttempts || 0;
                const baseDelay = 60000;
                const maxDelay = 3600000;
                const cooldownTime = Math.min(baseDelay * Math.pow(2, failedAttempts), maxDelay);

                this.logger.warn(`Max retries exceeded for ${folderPath}, marking as failed with ${cooldownTime/1000}s cooldown`);
                await this.stateService.markFailed(folderPath, "Max retries exceeded", cooldownTime);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                return;
            }

            // Read JSON file
            const files = await fs.readdir(folderPath);
            const jsonFile = files.find((file) => file.endsWith(".json"));
            if (!jsonFile) {
                throw new Error("No JSON file found");
            }

            const jsonFilePath = path.join(folderPath, jsonFile);
            const data = await this.fileService.readFile(jsonFilePath);

            // Now TypeScript knows that data has video_prompts
            const newFormatData = data as any; // Type assertion to work around type issues

            // Validate song with animal format with video_prompts
            if (!newFormatData.video_prompts || !Array.isArray(newFormatData.video_prompts) || newFormatData.video_prompts.length === 0) {
                throw new Error("No video_prompts found in JSON file");
            }

            // Get scene images
            const sceneImages = files.filter(file => file.match(/^scene_\d+\.png$/));
            if (newFormatData.video_prompts.length !== sceneImages.length) {
                throw new Error(`Mismatch between video_prompts count (${newFormatData.video_prompts.length}) and scene images count (${sceneImages.length})`);
            }

            // Get additional frame images from folder root (already manually selected)
            const additionalFrameImages = files.filter(file => file.match(/^additional_frame_\d+\.png$/));
            const additionalFramesCount = newFormatData.additional_frames ? newFormatData.additional_frames.length : 0;
            
            if (additionalFramesCount > 0 && additionalFrameImages.length !== additionalFramesCount) {
                throw new Error(`Mismatch between additional_frames count (${additionalFramesCount}) and additional frame images count (${additionalFrameImages.length})`);
            }

            this.logger.info(`Found ${newFormatData.video_prompts.length} video prompts and ${sceneImages.length} scene images`);
            if (additionalFramesCount > 0) {
                this.logger.info(`Found ${additionalFramesCount} additional frames and ${additionalFrameImages.length} additional frame images`);
            }

            // Process videos in batches of 12
            const batchSize = 12;
            const totalVideos = newFormatData.video_prompts.length;
            const allErrors: Array<{ type: string; index: number | string; error: string }> = [];
            
            this.logger.info(`Starting batch video generation: ${totalVideos} videos in batches of ${batchSize}`);
            
            for (let batchStart = 0; batchStart < totalVideos; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, totalVideos);
                const currentBatch = batchEnd - batchStart;
                
                this.logger.info(`Processing batch ${Math.floor(batchStart / batchSize) + 1}: scenes ${batchStart} to ${batchEnd - 1} (${currentBatch} videos)`);
                
                const videoPromises = [];
                
                for (let i = batchStart; i < batchEnd; i++) {
                    const videoPrompt = newFormatData.video_prompts[i];
                    const imagePath = path.join(folderPath, `scene_${i}.png`);
                    const videoPath = path.join(folderPath, `scene_${i}.mp4`);

                    // Check if image exists
                    if (!await fs.pathExists(imagePath)) {
                        allErrors.push({ type: 'scene', index: i, error: `Image file not found: ${imagePath}` });
                        continue;
                    }

                    // Skip if video already exists
                    if (await fs.pathExists(videoPath)) {
                        this.logger.info(`Video already exists for scene ${i}, skipping`);
                        continue;
                    }

                    this.logger.info(`Adding scene ${i} to batch for video generation`);
                    
                    const videoPromise = this.videoService.generateVideo(
                        videoPrompt.video_prompt,
                        imagePath,
                        videoPath,
                        6 // duration
                    ).then(async (videoResult) => {
                        // Save video metadata
                        await this.saveVideoMeta(folderPath, i, videoResult);
                        this.logger.info(`Successfully generated video for scene ${i}`);
                        return { index: i, success: true };
                    }).catch(async (error) => {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        this.logger.error(`Failed to generate video for scene ${i}: ${errorMessage}`);
                        allErrors.push({ type: 'scene', index: i, error: errorMessage });
                        return { index: i, success: false, error: errorMessage };
                    });
                    
                    videoPromises.push(videoPromise);
                }
                
                // Wait for current batch to complete
                if (videoPromises.length > 0) {
                    const batchResults = await Promise.all(videoPromises);
                    
                    // Log batch results
                    const successfulCount = batchResults.filter(r => r.success).length;
                    this.logger.info(`Batch ${Math.floor(batchStart / batchSize) + 1} completed: ${successfulCount}/${currentBatch} videos generated successfully`);
                    
                    // Log failed generations but don't throw error
                    const failedResults = batchResults.filter(r => !r.success) as Array<{ index: number; success: boolean; error: string }>;
                    if (failedResults.length > 0) {
                        this.logger.warn(`Some videos failed in batch ${Math.floor(batchStart / batchSize) + 1}:`);
                        failedResults.forEach(result => {
                            this.logger.warn(`  Scene ${result.index}: ❌ Failed - ${result.error}`);
                        });
                    }
                }
            }

            // Process additional frames if they exist
            if (additionalFramesCount > 0) {
                this.logger.info(`Starting additional frames video generation: ${additionalFramesCount} additional frames`);
                
                const additionalFramePromises = [];
                
                for (let i = 0; i < additionalFramesCount; i++) {
                    const frame = newFormatData.additional_frames[i];
                    
                    // Use manually selected image from folder root
                    const imagePath = path.join(folderPath, `additional_frame_${frame.index}.png`);
                    const videoPath = path.join(folderPath, `additional_frame_${frame.index}.mp4`);

                    // Check if image exists
                    if (!await fs.pathExists(imagePath)) {
                        allErrors.push({ type: 'additional_frame', index: frame.index, error: `Additional frame image file not found: ${imagePath}` });
                        continue;
                    }

                    // Skip if video already exists
                    if (await fs.pathExists(videoPath)) {
                        this.logger.info(`Video already exists for additional frame ${frame.index}, skipping`);
                        continue;
                    }

                    this.logger.info(`Adding additional frame ${frame.index} for video generation`);
                    
                    const videoPromise = this.videoService.generateVideo(
                        frame.group_video_prompt,
                        imagePath,
                        videoPath,
                        10 // duration
                    ).then(async (videoResult) => {
                        // Save video metadata
                        await this.saveVideoMeta(folderPath, `additional_frame_${frame.index}`, videoResult);
                        this.logger.info(`Successfully generated video for additional frame ${frame.index}`);
                        return { index: `additional_frame_${frame.index}`, success: true };
                    }).catch(async (error) => {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        this.logger.error(`Failed to generate video for additional frame ${frame.index}: ${errorMessage}`);
                        allErrors.push({ type: 'additional_frame', index: frame.index, error: errorMessage });
                        return { index: `additional_frame_${frame.index}`, success: false, error: errorMessage };
                    });
                    
                    additionalFramePromises.push(videoPromise);
                }
                
                // Wait for additional frames generation to complete
                if (additionalFramePromises.length > 0) {
                    const additionalFrameResults = await Promise.all(additionalFramePromises);
                    
                    // Log additional frames results
                    const successfulCount = additionalFrameResults.filter(r => r.success).length;
                    this.logger.info(`Additional frames completed: ${successfulCount}/${additionalFramePromises.length} videos generated successfully`);
                    
                    // Log failed generations but don't throw error
                    const failedResults = additionalFrameResults.filter(r => !r.success) as Array<{ index: string; success: boolean; error: string }>;
                    if (failedResults.length > 0) {
                        this.logger.warn(`Some additional frame videos failed:`);
                        failedResults.forEach(result => {
                            this.logger.warn(`  Additional Frame ${result.index}: ❌ Failed - ${result.error}`);
                        });
                    }
                }
            }

            // Make a decision about the folder's fate based on collected errors
            if (allErrors.length > 0) {
                this.logger.warn(`Video generation completed with ${allErrors.length} errors:`);
                allErrors.forEach(error => {
                    this.logger.warn(`  ${error.type} ${error.index}: ${error.error}`);
                });
                
                // If there are errors, move folder to failed
                this.logger.error(`Moving folder to failed due to ${allErrors.length} errors`);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
            } else {
                this.logger.info(`All videos generated successfully, marking as completed`);
                await this.stateService.markCompleted(folderPath);
            }
            
        } catch (error: unknown) {
            this.logger.error(`Error processing song with animal folder: ${folderPath}`, error);
            try {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                await this.stateService.markFailed(folderPath, errorMessage);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
            } catch (stateError) {
                this.logger.error(`Error updating state for ${folderPath}`, stateError);
            }
        } finally {
            try {
                if (!lockReleased) {
                    await this.lockService.releaseLock(folderPath);
                    lockReleased = true;
                    this.logger.info(`Lock released for ${folderPath}`);
                }
            } catch (lockError) {
                this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
            }
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
