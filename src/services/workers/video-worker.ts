import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { StateService } from '../core/state-service';
import { VideoService } from '../generators/video-service';
import { Logger, isSingleVideoFormat, isSongWithAnimalWithVideoPrompts, isStudyWithEnhancedMedia } from '../../utils';
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
                
                // 1. Priority: song with animal format with scene_*.png images
                const songWithAnimalFolders = this.findSongWithAnimalFolders(unprocessedFolders);
                if (songWithAnimalFolders.length > 0) {
                    this.logger.info(`Found ${songWithAnimalFolders.length} song with animal folders for video generation`);
                    await this.processSongWithAnimalFolder(songWithAnimalFolders[0]);
                    continue;
                }

                // 2. Study format with base_0.png
                const studyFolders = this.findStudyFolders(unprocessedFolders);
                if (studyFolders.length > 0) {
                    this.logger.info(`Found ${studyFolders.length} study format folders for video generation`);
                    await this.processStudyFolder(studyFolders[0]);
                    continue;
                }

                // 3. New format with single video - look for JSON files in unprocessed
                const unprocessedFiles = await this.fileService.getUnprocessedFiles();
                const studyShortsFiles = this.findStudyShorts(unprocessedFiles);
                if (studyShortsFiles.length > 0) {
                    this.logger.info(`Found ${studyShortsFiles.length} study shorts format files for video generation`);
                    await this.processSingleVideoFile(studyShortsFiles[0]);
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

    private findSongWithAnimalFolders(folders: string[]): string[] {
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

    private findStudyFolders(folders: string[]): string[] {
        return folders.filter(folder => {
            try {
                const files = fs.readdirSync(folder);
                const hasBase0 = files.includes('base_0.png');
                const hasJson = files.some(f => f.endsWith('.json'));
                return hasBase0 && hasJson;
            } catch {
                return false;
            }
        });
    }

    private findStudyShorts(files: string[]): string[] {
        return files.filter(filePath => {
            try {
                // Read JSON file to check structure
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                
                // Check new format structure
                return isSingleVideoFormat(data);
            } catch {
                return false;
            }
        });
    }

    private async processSongWithAnimalFolder(folderPath: string): Promise<void> {
        const folderName = path.basename(folderPath);
        const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);

        try {
            // Move folder to in-progress
            await fs.move(folderPath, inProgressPath, { overwrite: true });
            this.logger.info(`Processing song with animal folder: ${inProgressPath}`);
            
            await this.processSongWithAnimalVideoGeneration(inProgressPath);
            
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

    private async processStudyFolder(folderPath: string): Promise<void> {
        const folderName = path.basename(folderPath);
        const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);

        try {
            // Move folder to in-progress
            await fs.move(folderPath, inProgressPath, { overwrite: true });
            this.logger.info(`Processing study format folder: ${inProgressPath}`);
            
            await this.processStudyVideoGeneration(inProgressPath);
            
            // Move to processed
            await this.fileService.moveProcessedFolder(folderName);
            this.logger.info(`Successfully processed study format folder: ${folderName}`);
            
        } catch (error) {
            this.logger.error(`Error processing study format folder ${inProgressPath}:`, error);
            
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

    private async processSingleVideoFile(filePath: string): Promise<void> {
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Check if this folder is already being processed by a worker
        if (await fs.pathExists(folderPath)) {
            this.logger.info(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }

        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        if (!lockAcquired) {
            this.logger.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            await fs.remove(folderPath);
            return;
        }

        try {
            // Move JSON from unprocessed to the folder
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });

            this.logger.info(`Processing single video format file: ${filePath}`);
            
            await this.processSingleVideoGeneration(folderPath);
            
            // Move to processed
            await this.fileService.moveProcessedFolder(folderName);
            this.logger.info(`Successfully processed single video format file: ${filePath}`);
            
        } catch (error) {
            this.logger.error(`Error processing single video format file ${filePath}:`, error);
            
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
        // Lock is automatically released in moveProcessedFolder/moveFailedFolder
    }

    private async processSongWithAnimalVideoGeneration(folderPath: string): Promise<void> {
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

            // Check that this is song with animal format with video_prompts
            if (!isSongWithAnimalWithVideoPrompts(data)) {
                throw new Error("Data is not in song with animal format with video_prompts");
            }

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

    private async processStudyVideoGeneration(folderPath: string): Promise<void> {
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

            // Check that this is study format with enhancedMedia
            if (!isStudyWithEnhancedMedia(data)) {
                throw new Error("Data is not in study format with enhancedMedia");
            }

            // Now TypeScript knows that data has enhancedMedia
            const oldFormatData = data as any; // Type assertion to work around type issues

            // Validate study format with enhancedMedia
            if (!oldFormatData.enhancedMedia || !Array.isArray(oldFormatData.enhancedMedia) || oldFormatData.enhancedMedia.length === 0) {
                throw new Error("No enhancedMedia found in JSON file");
            }

            // Filter and sort scenes for processing
            const numericScenes = oldFormatData.enhancedMedia
                .filter((media: any) => typeof media.scene === 'number')
                .sort((a: any, b: any) => (a.scene as number) - (b.scene as number));

            if (numericScenes.length === 0) {
                throw new Error("No numeric scenes found in JSON file");
            }

            // Check for presence of scene 0
            const hasScene0 = numericScenes.some((media: any) => media.scene === 0);
            if (!hasScene0) {
                throw new Error("No scene 0 found in JSON file");
            }

            // Look for final scene
            const finalScene = oldFormatData.enhancedMedia.find((media: any) => media.scene === "final");

            this.logger.info(`Found ${numericScenes.length} numeric scenes and ${finalScene ? '1' : '0'} final scene`);

            // Get already completed scenes
            const completedScenes = state.completedScenes || [];

            // Process scenes
            await this.processStudyScenes(folderPath, numericScenes, finalScene, completedScenes);

            await this.stateService.markCompleted(folderPath);
            
        } catch (error: unknown) {
            this.logger.error(`Error processing study format folder: ${folderPath}`, error);
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

    private async processSingleVideoGeneration(folderPath: string): Promise<void> {
        let lockReleased = false;
        
        try {
            // Lock already acquired in processSingleVideoFile, don't need to acquire it again

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

            // Check that this is new format with single video
            if (!isSingleVideoFormat(data)) {
                throw new Error("Data is not in single video format");
            }

            // Type assertion for new format
            const singleVideoData = data as any;

            // Validate structure
            if (!singleVideoData.song || !singleVideoData.video_prompt || !singleVideoData.video_prompt.video_prompt) {
                throw new Error("Invalid single video format: missing required fields");
            }

            this.logger.info(`Processing single video generation for: ${singleVideoData.title || 'Untitled'}`);

            // Path to blank-video.png image in generations folder
            const blankImagePath = path.join(this.fileService.getBaseDir(), 'blank-video.png');
            
            // Check if image exists
            if (!await fs.pathExists(blankImagePath)) {
                throw new Error(`Blank video image not found: ${blankImagePath}`);
            }

            // Path for output video
            const videoPath = path.join(folderPath, 'video.mp4');

            // Check if video already exists
            if (await fs.pathExists(videoPath)) {
                this.logger.info(`Video already exists, skipping generation`);
                await this.stateService.markCompleted(folderPath);
                return;
            }

            // Generate video
            this.logger.info(`Generating single video with prompt: ${singleVideoData.video_prompt.video_prompt.substring(0, 100)}...`);
            
            const videoResult = await this.videoService.generateVideo(
                singleVideoData.video_prompt.video_prompt,
                blankImagePath,
                videoPath,
                10 // duration
            );

            // Save video metadata
            await this.saveVideoMeta(folderPath, 'single', videoResult);

            this.logger.info(`Successfully generated single video: ${videoPath}`);
            await this.stateService.markCompleted(folderPath);
            
        } catch (error: unknown) {
            this.logger.error(`Error processing single video folder: ${folderPath}`, error);
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

    private async processStudyScenes(
        folderPath: string,
        numericScenes: any[],
        finalScene: any,
        completedScenes: number[]
    ): Promise<void> {
        this.logger.info(`Processing scenes for ${folderPath}. Completed scenes: ${JSON.stringify(completedScenes)}`);

        // Check that we have scene 0
        const firstScene = numericScenes.find(media => media.scene === 0);
        if (!firstScene) {
            throw new Error(`No scene 0 found in folder: ${folderPath}`);
        }

        // Check file system state
        await this.verifyFileSystemState(folderPath, completedScenes);

        // Process first scene (scene 0)
        if (!completedScenes.includes(0)) {
            await this.processFirstScene(folderPath, firstScene);
            await this.stateService.markSceneCompleted(folderPath, 0);
            
            // Reload completed scenes
            const state = await this.stateService.getState(folderPath);
            if (state) {
                completedScenes = state.completedScenes || [];
            }
        }

        // Process subsequent scenes
        for (let i = 1; i < numericScenes.length; i++) {
            const scene = numericScenes[i];
            const sceneNumber = scene.scene as number;

            // Skip if scene is already completed
            if (completedScenes.includes(sceneNumber)) {
                this.logger.info(`Skipping already completed scene ${sceneNumber}`);
                continue;
            }

            await this.processSubsequentScene(folderPath, scene, sceneNumber, completedScenes);
            await this.stateService.markSceneCompleted(folderPath, sceneNumber);
            
            // Reload completed scenes
            const updatedState = await this.stateService.getState(folderPath);
            if (updatedState) {
                completedScenes = updatedState.completedScenes || [];
            }
        }

        // Process final scene if it exists
        if (finalScene && !completedScenes.includes(-1)) {
            await this.processFinalScene(folderPath, finalScene, numericScenes, completedScenes);
            await this.stateService.markSceneCompleted(folderPath, -1);
        }
    }

    private async processFirstScene(folderPath: string, firstScene: any): Promise<void> {
        const firstSceneNumber = firstScene.scene as number;
        const firstBaseImagePath = `${folderPath}/base_${firstSceneNumber}.png`;
        const firstVideoPath = `${folderPath}/scene_${firstSceneNumber}.mp4`;

        this.logger.info(`Processing first scene (${firstSceneNumber})`);

        // Check if base image exists
        if (!await fs.pathExists(firstBaseImagePath)) {
            this.logger.info(`Base image not found for scene ${firstSceneNumber}, skipping video generation`);
            return;
        }

        // Generate video for first scene if it doesn't exist
        if (!await fs.pathExists(firstVideoPath)) {
            this.logger.info(`Generating video for scene ${firstSceneNumber}`);
            let duration = 6;
            if (firstScene.duration === 6 || firstScene.duration === 10 || firstScene.duration === "6" || firstScene.duration === "10") {
                duration = Number(firstScene.duration);
            }
            const videoResult = await this.videoService.generateVideo(firstScene.video_prompt, firstBaseImagePath, firstVideoPath, duration);
            await this.saveVideoMeta(folderPath, firstSceneNumber, videoResult);
        }
    }

    private async processSubsequentScene(folderPath: string, scene: any, sceneNumber: number, completedScenes: number[]): Promise<void> {
        this.logger.info(`Processing scene ${sceneNumber}`);

        const previousSceneNumber = sceneNumber - 1;

        // Paths for current scene
        const baseImagePath = `${folderPath}/base_${sceneNumber}.png`;
        const videoPath = `${folderPath}/scene_${sceneNumber}.mp4`;

        // Path for previous scene's video
        const previousVideoPath = `${folderPath}/scene_${previousSceneNumber}.mp4`;

        // Make sure previous scene is completed
        if (!completedScenes.includes(previousSceneNumber)) {
            const prevBaseImagePath = `${folderPath}/base_${previousSceneNumber}.png`;
            const prevVideoPath = `${folderPath}/scene_${previousSceneNumber}.mp4`;

            if (await fs.pathExists(prevBaseImagePath) && await fs.pathExists(prevVideoPath)) {
                this.logger.warn(`Previous scene ${previousSceneNumber} files exist but not marked as completed. Marking as completed.`);
                await this.stateService.markSceneCompleted(folderPath, previousSceneNumber);
            } else {
                throw new Error(`Cannot process scene ${sceneNumber} before scene ${previousSceneNumber} is completed`);
            }
        }

        // Check if previous scene's video exists
        if (!await fs.pathExists(previousVideoPath)) {
            throw new Error(`Previous scene's video not found: ${previousVideoPath}`);
        }

        // Extract last frame from previous scene's video if needed
        if (!await fs.pathExists(baseImagePath)) {
            this.logger.info(`Extracting last frame from scene ${previousSceneNumber} video`);
            await this.videoService.extractLastFrame(previousVideoPath, baseImagePath);
        }

        // Generate video for current scene if needed
        if (!await fs.pathExists(videoPath)) {
            this.logger.info(`Generating video for scene ${sceneNumber}`);
            let duration = 6;
            if (scene.duration === 6 || scene.duration === 10 || scene.duration === "6" || scene.duration === "10") {
                duration = Number(scene.duration);
            }
            const videoResult = await this.videoService.generateVideo(scene.video_prompt, baseImagePath, videoPath, duration);
            await this.saveVideoMeta(folderPath, sceneNumber, videoResult);
        }
    }

    private async processFinalScene(folderPath: string, finalScene: any, numericScenes: any[], completedScenes: number[]): Promise<void> {
        this.logger.info('Processing final scene');

        // Get last numeric scene
        const lastNumericScene = numericScenes[numericScenes.length - 1];
        const lastSceneNumber = lastNumericScene.scene as number;

        // Paths for final scene
        const finalBaseImagePath = `${folderPath}/base_final.png`;
        const finalVideoPath = `${folderPath}/scene_final.mp4`;

        // Path for last numeric scene's video
        const lastVideoPath = `${folderPath}/scene_${lastSceneNumber}.mp4`;

        // Make sure last numeric scene is completed
        if (!completedScenes.includes(lastSceneNumber)) {
            throw new Error(`Cannot process final scene before scene ${lastSceneNumber} is completed`);
        }

        // Check if last scene's video exists
        if (!await fs.pathExists(lastVideoPath)) {
            throw new Error(`Last scene's video not found: ${lastVideoPath}`);
        }

        // Extract last frame from last numeric scene's video if needed
        if (!await fs.pathExists(finalBaseImagePath)) {
            this.logger.info(`Extracting last frame from scene ${lastSceneNumber} video for final scene`);
            await this.videoService.extractLastFrame(lastVideoPath, finalBaseImagePath);
        }

        // Generate video for final scene if needed
        if (!await fs.pathExists(finalVideoPath)) {
            this.logger.info('Generating video for final scene');
            let duration = 6;
            if (finalScene && (finalScene.duration === 6 || finalScene.duration === 10 || finalScene.duration === "6" || finalScene.duration === "10")) {
                duration = Number(finalScene.duration);
            }
            const videoResult = await this.videoService.generateVideo(finalScene.video_prompt, finalBaseImagePath, finalVideoPath, duration);
            await this.saveVideoMeta(folderPath, 'final', videoResult);
        }
    }

    private async verifyFileSystemState(folderPath: string, completedScenes: number[]): Promise<void> {
        this.logger.info(`Verifying file system state for ${folderPath}`);

        // Check that scenes are marked as completed but their files don't exist
        for (const sceneNumber of completedScenes) {
            if (sceneNumber === -1) {
                // Final scene
                const finalBaseImagePath = `${folderPath}/base_final.png`;
                const finalVideoPath = `${folderPath}/scene_final.mp4`;

                if (!await fs.pathExists(finalBaseImagePath) || !await fs.pathExists(finalVideoPath)) {
                    this.logger.warn(`Final scene is marked as completed but files don't exist. Removing from completed scenes.`);
                    await this.removeSceneFromCompleted(folderPath, sceneNumber);
                }
            } else {
                // Numeric scene
                const baseImagePath = `${folderPath}/base_${sceneNumber}.png`;
                const videoPath = `${folderPath}/scene_${sceneNumber}.mp4`;

                if (!await fs.pathExists(baseImagePath) || !await fs.pathExists(videoPath)) {
                    this.logger.warn(`Scene ${sceneNumber} is marked as completed but files don't exist. Removing from completed scenes.`);
                    await this.removeSceneFromCompleted(folderPath, sceneNumber);
                }
            }
        }

        // Check that scenes have files but are not marked as completed
        const files = await fs.readdir(folderPath);

        // Check numeric scenes
        for (const file of files) {
            if (file.startsWith('scene_') && file.endsWith('.mp4') && file !== 'scene_final.mp4') {
                const sceneNumber = parseInt(file.replace('scene_', '').replace('.mp4', ''));
                if (!isNaN(sceneNumber) && !completedScenes.includes(sceneNumber)) {
                    const baseImagePath = `${folderPath}/base_${sceneNumber}.png`;

                    if (await fs.pathExists(baseImagePath)) {
                        this.logger.warn(`Scene ${sceneNumber} has files but is not marked as completed. Marking as completed.`);
                        await this.stateService.markSceneCompleted(folderPath, sceneNumber);
                    }
                }
            }
        }

        // Check final scene
        if (files.includes('scene_final.mp4') && !completedScenes.includes(-1)) {
            const finalBaseImagePath = `${folderPath}/base_final.png`;

            if (await fs.pathExists(finalBaseImagePath)) {
                this.logger.warn(`Final scene has files but is not marked as completed. Marking as completed.`);
                await this.stateService.markSceneCompleted(folderPath, -1);
            }
        }
    }

    private async removeSceneFromCompleted(folderPath: string, sceneNumber: number): Promise<void> {
        const state = await this.stateService.getState(folderPath);
        if (state && state.completedScenes) {
            const newCompletedScenes = state.completedScenes.filter(scene => scene !== sceneNumber);
            state.completedScenes = newCompletedScenes;
            await this.stateService.updateState(folderPath, state);
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
