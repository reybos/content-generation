/**
 * Example implementation for processing continuous video scenes.
 * 
 * This class demonstrates how to generate videos where each subsequent video
 * continues from the last frame of the previous video. This creates a seamless
 * transition between scenes.
 * 
 * Usage example:
 * ```typescript
 * const processor = new ContinuousVideoProcessor(videoService, stateService, logger);
 * await processor.processStudyScenes(folderPath, numericScenes, finalScene, completedScenes);
 * ```
 * 
 * Note: FileService is no longer needed as saveVideoMeta is now in VideoService
 */

import { VideoService } from './video-service';
import { StateService } from '../core/state-service';
import { Logger } from '../../utils';
import { WorkerConfig } from '../../types';
import * as path from 'path';
import * as fs from 'fs-extra';

export class ContinuousVideoProcessor {
    private readonly MAIN_VIDEO_DURATION: number;
    private readonly ADDITIONAL_SCENE_DURATION: number;

    constructor(
        private videoService: VideoService,
        private stateService: StateService,
        private logger: Logger,
        config?: Partial<WorkerConfig>
    ) {
        this.MAIN_VIDEO_DURATION = config?.mainVideoDuration ?? 6;
        this.ADDITIONAL_SCENE_DURATION = config?.additionalSceneDuration ?? 10;
    }

    /**
     * Process scenes for continuous video generation.
     * Each subsequent video continues from the last frame of the previous video.
     * 
     * @param folderPath Path to the folder containing scene data
     * @param numericScenes Array of numeric scenes (scene 0, 1, 2, etc.)
     * @param finalScene Optional final scene
     * @param completedScenes Array of scene numbers that are already completed
     */
    public async processStudyScenes(
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
            let duration = this.MAIN_VIDEO_DURATION;
            if (firstScene.duration === 6 || firstScene.duration === 10 || firstScene.duration === "6" || firstScene.duration === "10") {
                duration = Number(firstScene.duration);
            }
            const videoResult = await this.videoService.generateVideo(firstScene.video_prompt, firstBaseImagePath, firstVideoPath, duration);
            await this.videoService.saveVideoMeta(folderPath, firstSceneNumber, videoResult);
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
            let duration = this.MAIN_VIDEO_DURATION;
            if (scene.duration === 6 || scene.duration === 10 || scene.duration === "6" || scene.duration === "10") {
                duration = Number(scene.duration);
            }
            const videoResult = await this.videoService.generateVideo(scene.video_prompt, baseImagePath, videoPath, duration);
            await this.videoService.saveVideoMeta(folderPath, sceneNumber, videoResult);
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
            let duration = this.ADDITIONAL_SCENE_DURATION;
            if (finalScene && (finalScene.duration === 6 || finalScene.duration === 10 || finalScene.duration === "6" || finalScene.duration === "10")) {
                duration = Number(finalScene.duration);
            }
            const videoResult = await this.videoService.generateVideo(finalScene.video_prompt, finalBaseImagePath, finalVideoPath, duration);
            await this.videoService.saveVideoMeta(folderPath, 'final', videoResult);
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
}

