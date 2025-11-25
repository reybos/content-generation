import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { StateService } from '../core/state-service';
import { VideoService, VideoGenerationTask, VideoGenerationResult } from '../generators/video-service';
import { Logger, isHalloweenFile, isPoemsFile } from '../../utils';
import { ContentType, WorkerConfig } from '../../types';
import * as path from 'path';
import * as fs from 'fs-extra';

export class VideoWorker {
    private fileService = new FileService();
    private videoService: VideoService;
    private lockService = new LockService();
    private stateService = new StateService();
    private logger = new Logger();
    private maxRetries = 5;

    constructor(config?: Partial<WorkerConfig>) {
        this.videoService = new VideoService(config);
    }

    public findFolderByType(folders: string[]): { folder: string; type: ContentType } | null {
        // Check folders in priority order
        for (const folder of folders) {
            const folderName = path.basename(folder);
            this.logger.info(`Checking folder: ${folderName}`);
            
            // Check Halloween pattern (only name, no structure check)
            if (isHalloweenFile(folderName)) {
                this.logger.info(`Folder ${folderName} matched Halloween pattern`);
                return { folder, type: ContentType.HALLOWEEN };
            }
            
            // Check Poems pattern (only name, no structure check)
            if (isPoemsFile(folderName)) {
                this.logger.info(`Folder ${folderName} matched Poems pattern`);
                return { folder, type: ContentType.POEMS };
            }
            
            this.logger.info(`Folder ${folderName} did not match any known pattern`);
        }
        
        return null;
    }

    public async processFolder(folderPath: string, folderType: ContentType): Promise<void> {
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

            // Process the folder (common logic)
            await this.processVideoFolder(inProgressPath, folderName, folderType);
            
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
        groupFrameTasks: VideoGenerationTask[]
    ): Promise<void> {
        this.logger.info(`Found ${sceneTasks.length} video prompts and scene images`);
        if (groupFrameTasks.length > 0) {
            this.logger.info(`Found ${groupFrameTasks.length} group frames`);
        }

        // Generate videos for main scenes
        const sceneResults = await this.videoService.generateVideoBatch(
            sceneTasks,
            folderPath,
            'scene'
        );

        // Generate videos for group frames if they exist
        let groupFrameResults: VideoGenerationResult[] = [];
        if (groupFrameTasks.length > 0) {
            groupFrameResults = await this.videoService.generateVideoBatch(
                groupFrameTasks,
                folderPath,
                'group_frame'
            );
        }

        // Collect all errors
        const allErrors = [...sceneResults, ...groupFrameResults].filter(r => !r.success);
        
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

    public async processDirectVideoFile(filePath: string): Promise<void> {
        const fileName = path.basename(filePath);
        const folderName = path.basename(filePath, path.extname(filePath));

        try {
            // 1. Setup folder and lock (similar to ImageWorker)
            const setupResult = await this.fileService.processFileWithLock(filePath, ContentType.POEMS_DIRECT_VIDEO);
            if (!setupResult) {
                return; // Already logged why it failed
            }

            const { folderPath } = setupResult;
            const inProgressPath = folderPath;

            // 2. Ensure blank-video.png exists in base directory and copy to folder if needed
            const blankVideoSource = path.resolve(process.cwd(), 'blank-video.png');
            const blankVideoInBase = path.join(this.fileService.getBaseDir(), 'blank-video.png');
            const blankVideoInFolder = path.join(inProgressPath, 'blank-video.png');

            // Copy blank-video.png to base directory if it doesn't exist there
            if (!await fs.pathExists(blankVideoInBase)) {
                if (await fs.pathExists(blankVideoSource)) {
                    await fs.copy(blankVideoSource, blankVideoInBase);
                    this.logger.info(`Copied blank-video.png to base directory: ${blankVideoInBase}`);
                } else {
                    throw new Error(`blank-video.png not found at ${blankVideoSource}`);
                }
            }

            // Copy blank-video.png to folder
            await fs.copy(blankVideoInBase, blankVideoInFolder);
            this.logger.info(`Copied blank-video.png to folder: ${blankVideoInFolder}`);

            // 3. Process the folder (common logic)
            await this.processVideoFolder(inProgressPath, folderName, ContentType.POEMS_DIRECT_VIDEO);
            this.logger.info(`Successfully processed direct-video file: ${fileName}`);
            
        } catch (error) {
            this.logger.error(`Error processing direct-video file ${filePath}:`, error);
            
            try {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);
                
                if (await fs.pathExists(inProgressPath)) {
                    await this.stateService.markFailed(inProgressPath, errorMessage);
                }
                await this.fileService.moveFailedFolder(folderName);
            } catch (stateError) {
                this.logger.error(`Error updating state for direct-video file ${filePath}`, stateError);
                try {
                    await this.fileService.moveFailedFolder(folderName);
                } catch (moveError) {
                    this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
                }
            }
        }
    }

    /**
     * Common logic for processing a video folder that is already in in-progress
     * Handles state initialization, retry checks, task preparation, video generation, and folder movement
     */
    private async processVideoFolder(
        inProgressPath: string,
        folderName: string,
        folderType: ContentType
    ): Promise<void> {
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
        const tasks = await this.videoService.prepareVideoTasks(folderType, inProgressPath);
        const sceneTasks = tasks.sceneTasks;
        const groupFrameTasks = tasks.groupFrameTasks;

        // Process videos (common logic for all types)
        await this.processVideos(inProgressPath, sceneTasks, groupFrameTasks);

        // Move to processed
        await this.fileService.moveProcessedFolder(folderName);
        this.logger.info(`Successfully processed folder: ${folderName}`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

}
