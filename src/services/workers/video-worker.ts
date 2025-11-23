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

    public async start(): Promise<void> {
        this.logger.info("Starting video generation worker");
        
        while (true) {
            try {
                // Look for folders in unprocessed for video processing
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                this.logger.info(`Found ${unprocessedFolders.length} folders in unprocessed directory`);
                
                if (unprocessedFolders.length > 0) {
                    this.logger.info(`Folder names: ${unprocessedFolders.map(f => path.basename(f)).join(', ')}`);
                }
                
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
            const tasks = await this.videoService.prepareVideoTasks(folderType, inProgressPath);
            const sceneTasks = tasks.sceneTasks;
            const additionalFrameTasks = tasks.additionalFrameTasks;

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
        const sceneResults = await this.videoService.generateVideoBatch(
            sceneTasks,
            folderPath,
            'scene'
        );

        // Generate videos for additional frames if they exist
        let additionalFrameResults: VideoGenerationResult[] = [];
        if (additionalFrameTasks.length > 0) {
            additionalFrameResults = await this.videoService.generateVideoBatch(
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

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

}
