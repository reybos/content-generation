/* START GENAI */

import { GenerationData } from "./types";
import { FileService, ImageService, VideoService, LockService, StateService, UniversalWorker } from "./services";
import { Logger, sleep } from "./utils";
import * as path from "path";
import * as fs from "fs-extra";
import { promises as fsp } from "fs";

/**
 * Worker for processing content generation tasks
 */
export class ContentGenerationWorker {
    private fileService = new FileService();
    private imageService = new ImageService();
    private videoService = new VideoService();
    private lockService = new LockService();
    private stateService = new StateService();
    private logger = new Logger();

    private activeProcesses = 0;
    private isRunning = false;
    private maxRetries = 5;

    public async start(): Promise<void> {
        this.logger.info("Starting content generation worker");
        this.isRunning = true;

        const universalWorker = new UniversalWorker();

        while (this.isRunning) {
            try {
                // 1. Preprocess: если есть json-файлы в unprocessed, сначала обрабатываем их
                const unprocessedFiles = await this.fileService.getUnprocessedFiles();
                if (unprocessedFiles.length > 0) {
                    this.logger.info(`Found ${unprocessedFiles.length} unprocessed JSON files, running universal worker`);
                    await universalWorker.start();
                    continue;
                }

                // 2. Основная обработка: ищем папки в unprocessed, где есть base_0.png и json
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                const candidateFolders: string[] = [];
                for (const folder of unprocessedFolders) {
                    const files = await fs.readdir(folder);
                    const hasBase0 = files.includes("base_0.png");
                    const hasJson = files.some(f => f.endsWith(".json"));
                    if (hasBase0 && hasJson) {
                        candidateFolders.push(folder);
                    }
                }

                // 3. Обработка нового типа папок: ищем папки с JSON и изображениями scene_*.png
                const newFormatCandidateFolders: string[] = [];
                for (const folder of unprocessedFolders) {
                    const files = await fs.readdir(folder);
                    const hasJson = files.some(f => f.endsWith(".json"));
                    const hasSceneImages = files.some(f => f.match(/^scene_\d+\.png$/));
                    if (hasJson && hasSceneImages) {
                        newFormatCandidateFolders.push(folder);
                    }
                }

                // Приоритет: сначала обрабатываем новый формат, потом старый
                if (newFormatCandidateFolders.length > 0) {
                    const folderName = path.basename(newFormatCandidateFolders[0]);
                    const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);
                    
                    try {
                        await fs.move(newFormatCandidateFolders[0], inProgressPath, { overwrite: true });
                        await this.processNewFormatFolder(inProgressPath);
                    } catch (error) {
                        this.logger.error(`Error processing new format folder ${inProgressPath}:`, error);
                        // Если произошла ошибка, попробуем вернуть папку обратно в unprocessed
                        try {
                            if (await fs.pathExists(inProgressPath)) {
                                await fs.move(inProgressPath, newFormatCandidateFolders[0], { overwrite: true });
                            }
                        } catch (moveError) {
                            this.logger.error(`Failed to move folder back to unprocessed:`, moveError);
                        }
                    }
                    continue;
                } else if (candidateFolders.length === 0) {
                    // this.logger.info('No folders to process, waiting...');
                    const jitter = Math.floor(Math.random() * 5000);
                    await sleep(25000 + jitter);
                    continue;
                }

                // Переносим папку из unprocessed в in-progress
                const folderName = path.basename(candidateFolders[0]);
                const inProgressPath = path.join(this.fileService.getInProgressDir(), folderName);
                await fs.move(candidateFolders[0], inProgressPath, { overwrite: true });
                // Продолжаем обработку по существующей логике
                await this.resumeProcessing(inProgressPath);
            } catch (error) {
                this.logger.error("Error in worker loop", error);
                await sleep(10000);
            }
        }
    }

    public stop(): void {
        this.logger.info("Stopping content generation worker");
        this.isRunning = false;
    }

    private async resumeProcessing(folderPath: string): Promise<void> {
        this.activeProcesses++;
        let lockReleased = false;
        try {
            this.logger.info(`Attempting to resume processing for folder: ${folderPath}`);

            const lockAcquired = await this.lockService.acquireLock(folderPath);
            if (!lockAcquired) {
                this.logger.info(`Could not acquire lock for ${folderPath}, skipping`);
                return;
            }

            const state = await this.stateService.initializeState(
                folderPath,
                this.lockService.getWorkerId(),
                this.maxRetries
            );

            // Check if max retries exceeded
            if (await this.stateService.hasExceededMaxRetries(folderPath)) {
                // Check if folder is in cooldown period
                if (await this.stateService.isInCooldown(folderPath)) {
                    this.logger.info(`Folder ${folderPath} is in cooldown period, skipping`);
                    try {
                        if (lockAcquired && !lockReleased) {
                            await this.lockService.releaseLock(folderPath);
                            lockReleased = true;
                        }
                    } catch (lockError) {
                        this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                    }
                    return;
                }

                // Calculate exponential backoff cooldown time based on failed attempts
                // Start with 1 minute, double for each attempt, cap at 1 hour
                const failedAttempts = state.failedAttempts || 0;
                const baseDelay = 60000; // 1 minute in milliseconds
                const maxDelay = 3600000; // 1 hour in milliseconds
                const cooldownTime = Math.min(baseDelay * Math.pow(2, failedAttempts), maxDelay);

                // Mark as failed with a cooldown period
                this.logger.warn(`Max retries exceeded for ${folderPath}, marking as failed with ${cooldownTime/1000}s cooldown`);
                await this.stateService.markFailed(folderPath, "Max retries exceeded", cooldownTime);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            const files = await fs.readdir(folderPath);
            const jsonFile = files.find((file) => file.endsWith(".json"));
            if (!jsonFile) {
                this.logger.error(`No JSON file found in ${folderPath}`);
                await this.stateService.markFailed(folderPath, "No JSON file found");
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Read the JSON file
            const jsonFilePath = path.join(folderPath, jsonFile);
            let data: any;

            try {
                data = await this.fileService.readFile(jsonFilePath);

                // Определяем формат и перенаправляем на соответствующую обработку
                if (data.video_prompts && Array.isArray(data.video_prompts) && data.video_prompts.length > 0) {
                    // Новый формат с video_prompts - обрабатываем как NewFormatWithVideo
                    this.logger.info(`Detected new format with video_prompts in ${folderPath}, processing as NewFormatWithVideo`);
                    await this.processNewFormatFolder(folderPath);
                    return;
                } else if (data.enhancedMedia && Array.isArray(data.enhancedMedia) && data.enhancedMedia.length > 0) {
                    // Старый формат с enhancedMedia - продолжаем как раньше
                    this.logger.info(`Detected old format with enhancedMedia in ${folderPath}, processing as OldFormat`);
                } else {
                    throw new Error("Unknown format: neither video_prompts nor enhancedMedia found");
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Error reading or parsing JSON file";
                this.logger.error(`${errorMessage} in ${folderPath}`);
                await this.stateService.markFailed(folderPath, errorMessage);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Продолжаем обработку старого формата
            const generationData = data as GenerationData;

            const numericScenes = generationData.enhancedMedia
                .filter((media) => typeof media.scene === "number")
                .sort((a, b) => (a.scene as number) - (b.scene as number));

            // Validate that we have at least one numeric scene
            if (numericScenes.length === 0) {
                this.logger.error(`No numeric scenes found in ${folderPath}`);
                await this.stateService.markFailed(folderPath, "No numeric scenes found in JSON file");
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Validate that we have scene 0
            const hasScene0 = numericScenes.some(media => media.scene === 0);
            if (!hasScene0) {
                this.logger.error(`No scene 0 found in ${folderPath}`);
                await this.stateService.markFailed(folderPath, "No scene 0 found in JSON file");
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Find the final scene if it exists
            const finalScene = generationData.enhancedMedia.find((media) => media.scene === "final");

            // Determine which scenes have been completed
            const completedScenes = state.completedScenes || [];

            this.logger.info(`Found ${numericScenes.length} numeric scenes and ${finalScene ? '1' : '0'} final scene in ${folderPath}`);
            this.logger.info(`Completed scenes: ${JSON.stringify(completedScenes)}`);

            await this.processScenes(folderPath, numericScenes, finalScene, completedScenes);

            await this.stateService.markCompleted(folderPath);
            try {
                if (lockAcquired && !lockReleased) {
                    await this.lockService.releaseLock(folderPath);
                    lockReleased = true;
                }
            } catch (lockError) {
                this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
            }
            await this.fileService.moveProcessedFolder(path.basename(folderPath));

            this.logger.info(`Successfully resumed and completed processing for ${folderPath}`);
        } catch (error: unknown) {
            this.logger.error(`Error resuming processing for ${folderPath}`, error);
            try {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                await this.stateService.markFailed(folderPath, errorMessage);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (!lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
            } catch (stateError) {
                this.logger.error(`Error updating state for ${folderPath}`, stateError);
            }
        } finally {
            this.activeProcesses--;
        }
    }

    private async processScenes(
        folderPath: string,
        numericScenes: any[],
        finalScene: any,
        completedScenes: number[]
    ): Promise<void> {
        this.logger.info(`Processing scenes for ${folderPath}. Completed scenes: ${JSON.stringify(completedScenes)}`);
        await this.appendWorkerLog(folderPath, `Processing scenes for ${folderPath}. Completed scenes: ${JSON.stringify(completedScenes)}`);

        // Validate that we have at least scene 0
        const firstScene = numericScenes.find(media => media.scene === 0);
        if (!firstScene) {
            this.logger.error(`No scene 0 found in folder: ${folderPath}`);
            await this.appendWorkerLog(folderPath, `No scene 0 found in folder: ${folderPath}`);
            throw new Error(`No scene 0 found in folder: ${folderPath}`);
        }

        // Verify file system state matches our state file
        await this.verifyFileSystemState(folderPath, completedScenes);

        // First, check if scene 0 has been processed
        if (!completedScenes.includes(0)) {
            // Generate base image for the first scene
            const firstSceneNumber = firstScene.scene as number;
            const firstBaseImagePath = `${folderPath}/base_${firstSceneNumber}.png`;
            const firstVideoPath = `${folderPath}/scene_${firstSceneNumber}.mp4`;

            this.logger.info(`Processing first scene (${firstSceneNumber}) for ${folderPath}`);
            await this.appendWorkerLog(folderPath, `Processing first scene (${firstSceneNumber}) for ${folderPath}`);

            // Update state to indicate we're processing this scene
            await this.stateService.setCurrentScene(folderPath, firstSceneNumber);

            // Check if base image exists, if not generate it
            if (!await fs.pathExists(firstBaseImagePath)) {
                this.logger.info(`Generating base image for scene ${firstSceneNumber}`);
                await this.appendWorkerLog(folderPath, `Generating base image for scene ${firstSceneNumber}`);
                try {
                    const imageResult = await this.imageService.generateImage(firstScene.image_prompt, firstBaseImagePath);
                    // Save image meta to meta.json
                    const metaPath = path.join(folderPath, 'meta.json');
                    let metaArr = [];
                    if (await fs.pathExists(metaPath)) {
                        metaArr = await fs.readJson(metaPath);
                    }
                    let sceneMeta = metaArr.find((m: any) => m.scene === firstSceneNumber);
                    if (!sceneMeta) {
                        sceneMeta = { scene: firstSceneNumber };
                        metaArr.push(sceneMeta);
                    }
                    sceneMeta.image = imageResult;
                    await fs.writeJson(metaPath, metaArr, { spaces: 2 });
                } catch (error) {
                    this.logger.error(`Failed to generate base image for scene ${firstSceneNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    await this.appendWorkerLog(folderPath, `Failed to generate base image for scene ${firstSceneNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    throw new Error(`Failed to generate base image for scene ${firstSceneNumber}`);
                }
            }

            // Check if video exists, if not generate it
            if (!await fs.pathExists(firstVideoPath)) {
                this.logger.info(`Generating video for scene ${firstSceneNumber}`);
                await this.appendWorkerLog(folderPath, `Generating video for scene ${firstSceneNumber}`);
                let duration = 6;
                if (firstScene.duration === 6 || firstScene.duration === 10 || firstScene.duration === "6" || firstScene.duration === "10") {
                    duration = Number(firstScene.duration);
                }
                const videoResult = await this.videoService.generateVideo(firstScene.video_prompt, firstBaseImagePath, firstVideoPath, duration);
                // Save video meta to meta.json
                const metaPath = path.join(folderPath, 'meta.json');
                let metaArr = [];
                if (await fs.pathExists(metaPath)) {
                    metaArr = await fs.readJson(metaPath);
                }
                let sceneMeta = metaArr.find((m: any) => m.scene === firstSceneNumber);
                if (!sceneMeta) {
                    sceneMeta = { scene: firstSceneNumber };
                    metaArr.push(sceneMeta);
                }
                sceneMeta.video = videoResult;
                await fs.writeJson(metaPath, metaArr, { spaces: 2 });
            }

            // Verify the files were created successfully
            if (!await fs.pathExists(firstBaseImagePath) || !await fs.pathExists(firstVideoPath)) {
                await this.appendWorkerLog(folderPath, `Failed to generate files for scene ${firstSceneNumber}`);
                throw new Error(`Failed to generate files for scene ${firstSceneNumber}`);
            }

            // Mark scene as completed
            await this.stateService.markSceneCompleted(folderPath, firstSceneNumber);

            // Reload completed scenes to ensure we have the latest state
            const state = await this.stateService.getState(folderPath);
            if (state) {
                completedScenes = state.completedScenes || [];
                this.logger.info(`Updated completed scenes after processing scene 0: ${JSON.stringify(completedScenes)}`);
                await this.appendWorkerLog(folderPath, `Updated completed scenes after processing scene 0: ${JSON.stringify(completedScenes)}`);
            }
        }

        // Process subsequent scenes
        for (let i = 1; i < numericScenes.length; i++) {
            const scene = numericScenes[i];
            const sceneNumber = scene.scene as number;

            // Skip if this scene has already been completed
            if (completedScenes.includes(sceneNumber)) {
                this.logger.info(`Skipping already completed scene ${sceneNumber}`);
                await this.appendWorkerLog(folderPath, `Skipping already completed scene ${sceneNumber}`);
                continue;
            }

            this.logger.info(`Processing scene ${sceneNumber} for ${folderPath}`);
            await this.appendWorkerLog(folderPath, `Processing scene ${sceneNumber} for ${folderPath}`);

            const previousSceneNumber = sceneNumber - 1;

            // Paths for the current scene
            const baseImagePath = `${folderPath}/base_${sceneNumber}.png`;
            const videoPath = `${folderPath}/scene_${sceneNumber}.mp4`;

            // Path for the previous scene's video
            const previousVideoPath = `${folderPath}/scene_${previousSceneNumber}.mp4`;

            // Update state to indicate we're processing this scene
            await this.stateService.setCurrentScene(folderPath, sceneNumber);

            // Double-check the state file again to ensure we have the latest state
            const currentState = await this.stateService.getState(folderPath);
            const currentCompletedScenes = currentState ? currentState.completedScenes || [] : [];

            // Ensure the previous scene has been completed
            if (!currentCompletedScenes.includes(previousSceneNumber)) {
                this.logger.warn(`Previous scene ${previousSceneNumber} not completed yet according to state file. State: ${JSON.stringify(currentCompletedScenes)}`);
                await this.appendWorkerLog(folderPath, `Previous scene ${previousSceneNumber} not completed yet according to state file. State: ${JSON.stringify(currentCompletedScenes)}`);

                // Check if the previous scene's files actually exist, which would indicate it's completed
                const prevBaseImagePath = `${folderPath}/base_${previousSceneNumber}.png`;
                const prevVideoPath = `${folderPath}/scene_${previousSceneNumber}.mp4`;

                if (await fs.pathExists(prevBaseImagePath) && await fs.pathExists(prevVideoPath)) {
                    this.logger.warn(`Previous scene ${previousSceneNumber} files exist but not marked as completed. Marking as completed.`);
                    await this.appendWorkerLog(folderPath, `Previous scene ${previousSceneNumber} files exist but not marked as completed. Marking as completed.`);
                    await this.stateService.markSceneCompleted(folderPath, previousSceneNumber);

                    // Reload completed scenes
                    const updatedState = await this.stateService.getState(folderPath);
                    if (updatedState) {
                        completedScenes = updatedState.completedScenes || [];
                    }
                } else {
                    // We need to process scenes in order, so we'll throw an error and let the retry mechanism handle it
                    await this.appendWorkerLog(folderPath, `Cannot process scene ${sceneNumber} before scene ${previousSceneNumber} is completed`);
                    throw new Error(`Cannot process scene ${sceneNumber} before scene ${previousSceneNumber} is completed`);
                }
            }

            // Check if previous scene's video exists
            if (!await fs.pathExists(previousVideoPath)) {
                this.logger.error(`Previous scene's video not found: ${previousVideoPath}`);
                await this.appendWorkerLog(folderPath, `Previous scene's video not found: ${previousVideoPath}`);
                throw new Error(`Previous scene's video not found: ${previousVideoPath}`);
            }

            // Extract the last frame from the previous scene's video if needed
            if (!await fs.pathExists(baseImagePath)) {
                this.logger.info(`Extracting last frame from scene ${previousSceneNumber} video`);
                await this.appendWorkerLog(folderPath, `Extracting last frame from scene ${previousSceneNumber} video`);
                try {
                    await this.videoService.extractLastFrame(previousVideoPath, baseImagePath);
                } catch (error) {
                    this.logger.error(`Failed to extract last frame from ${previousVideoPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    await this.appendWorkerLog(folderPath, `Failed to extract last frame from ${previousVideoPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    throw new Error(`Failed to extract last frame from ${previousVideoPath}`);
                }
            }

            // Generate video for the current scene if needed
            if (!await fs.pathExists(videoPath)) {
                this.logger.info(`Generating video for scene ${sceneNumber}`);
                await this.appendWorkerLog(folderPath, `Generating video for scene ${sceneNumber}`);
                try {
                    let duration = 6;
                    if (scene.duration === 6 || scene.duration === 10 || scene.duration === "6" || scene.duration === "10") {
                        duration = Number(scene.duration);
                    }
                    const videoResult = await this.videoService.generateVideo(scene.video_prompt, baseImagePath, videoPath, duration);
                    // Save video meta to meta.json
                    const metaPath = path.join(folderPath, 'meta.json');
                    let metaArr = [];
                    if (await fs.pathExists(metaPath)) {
                        metaArr = await fs.readJson(metaPath);
                    }
                    let sceneMeta = metaArr.find((m: any) => m.scene === sceneNumber);
                    if (!sceneMeta) {
                        sceneMeta = { scene: sceneNumber };
                        metaArr.push(sceneMeta);
                    }
                    sceneMeta.video = videoResult;
                    await fs.writeJson(metaPath, metaArr, { spaces: 2 });
                } catch (error) {
                    this.logger.error(`Failed to generate video for scene ${sceneNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    await this.appendWorkerLog(folderPath, `Failed to generate video for scene ${sceneNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    throw new Error(`Failed to generate video for scene ${sceneNumber}`);
                }
            }

            // Verify the files were created successfully
            if (!await fs.pathExists(baseImagePath) || !await fs.pathExists(videoPath)) {
                await this.appendWorkerLog(folderPath, `Failed to generate files for scene ${sceneNumber}`);
                throw new Error(`Failed to generate files for scene ${sceneNumber}`);
            }

            // Mark scene as completed
            await this.stateService.markSceneCompleted(folderPath, sceneNumber);

            // Reload completed scenes to ensure we have the latest state
            const updatedState = await this.stateService.getState(folderPath);
            if (updatedState) {
                completedScenes = updatedState.completedScenes || [];
                this.logger.info(`Updated completed scenes after processing scene ${sceneNumber}: ${JSON.stringify(completedScenes)}`);
                await this.appendWorkerLog(folderPath, `Updated completed scenes after processing scene ${sceneNumber}: ${JSON.stringify(completedScenes)}`);
            }
        }

        // Process the final scene if it exists and hasn't been completed
        if (finalScene && !completedScenes.includes(-1)) { // Use -1 to represent the final scene
            this.logger.info(`Processing final scene for ${folderPath}`);
            await this.appendWorkerLog(folderPath, `Processing final scene for ${folderPath}`);

            // Get the last numeric scene
            const lastNumericScene = numericScenes[numericScenes.length - 1];
            const lastSceneNumber = lastNumericScene.scene as number;

            // Paths for the final scene
            const finalBaseImagePath = `${folderPath}/base_final.png`;
            const finalVideoPath = `${folderPath}/scene_final.mp4`;

            // Path for the last numeric scene's video
            const lastVideoPath = `${folderPath}/scene_${lastSceneNumber}.mp4`;

            // Update state to indicate we're processing the final scene
            await this.stateService.setCurrentScene(folderPath, -1); // Use -1 to represent the final scene

            // Ensure the last numeric scene has been completed
            if (!completedScenes.includes(lastSceneNumber)) {
                this.logger.warn(`Last numeric scene ${lastSceneNumber} not completed yet. Cannot process final scene.`);
                await this.appendWorkerLog(folderPath, `Last numeric scene ${lastSceneNumber} not completed yet. Cannot process final scene.`);
                throw new Error(`Cannot process final scene before scene ${lastSceneNumber} is completed`);
            }

            // Check if last scene's video exists
            if (!await fs.pathExists(lastVideoPath)) {
                this.logger.error(`Last scene's video not found: ${lastVideoPath}`);
                await this.appendWorkerLog(folderPath, `Last scene's video not found: ${lastVideoPath}`);
                throw new Error(`Last scene's video not found: ${lastVideoPath}`);
            }

            // Extract the last frame from the last numeric scene's video if needed
            if (!await fs.pathExists(finalBaseImagePath)) {
                this.logger.info(`Extracting last frame from scene ${lastSceneNumber} video for final scene`);
                await this.appendWorkerLog(folderPath, `Extracting last frame from scene ${lastSceneNumber} video for final scene`);
                await this.videoService.extractLastFrame(lastVideoPath, finalBaseImagePath);
            }

            // Generate video for the final scene if needed
            if (!await fs.pathExists(finalVideoPath)) {
                this.logger.info('Generating video for final scene');
                await this.appendWorkerLog(folderPath, 'Generating video for final scene');
                let duration = 6;
                if (finalScene && (finalScene.duration === 6 || finalScene.duration === 10 || finalScene.duration === "6" || finalScene.duration === "10")) {
                    duration = Number(finalScene.duration);
                }
                const videoResult = await this.videoService.generateVideo(finalScene.video_prompt, finalBaseImagePath, finalVideoPath, duration);
                // Save video meta to meta.json
                const metaPath = path.join(folderPath, 'meta.json');
                let metaArr = [];
                if (await fs.pathExists(metaPath)) {
                    metaArr = await fs.readJson(metaPath);
                }
                let sceneMeta = metaArr.find((m: any) => m.scene === 'final');
                if (!sceneMeta) {
                    sceneMeta = { scene: 'final' };
                    metaArr.push(sceneMeta);
                }
                sceneMeta.video = videoResult;
                await fs.writeJson(metaPath, metaArr, { spaces: 2 });
            }

            // Mark final scene as completed
            await this.stateService.markSceneCompleted(folderPath, -1); // Use -1 to represent the final scene
            this.logger.info(`Final scene processing completed for ${folderPath}`);
            await this.appendWorkerLog(folderPath, `Final scene processing completed for ${folderPath}`);
        }
    }

    /**
     * Process a new format folder with JSON and scene images
     */
    private async processNewFormatFolder(folderPath: string): Promise<void> {
        this.activeProcesses++;
        let lockReleased = false;
        try {
            this.logger.info(`Processing new format folder: ${folderPath}`);

            const lockAcquired = await this.lockService.acquireLock(folderPath);
            if (!lockAcquired) {
                this.logger.info(`Could not acquire lock for ${folderPath}, skipping`);
                return;
            }

            this.logger.info(`Lock acquired for ${folderPath}, initializing state`);

            const state = await this.stateService.initializeState(
                folderPath,
                this.lockService.getWorkerId(),
                this.maxRetries
            );

            // Check if max retries exceeded
            if (await this.stateService.hasExceededMaxRetries(folderPath)) {
                if (await this.stateService.isInCooldown(folderPath)) {
                    this.logger.info(`Folder ${folderPath} is in cooldown period, skipping`);
                    try {
                        if (lockAcquired && !lockReleased) {
                            await this.lockService.releaseLock(folderPath);
                            lockReleased = true;
                        }
                    } catch (lockError) {
                        this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                    }
                    return;
                }

                const failedAttempts = state.failedAttempts || 0;
                const baseDelay = 60000;
                const maxDelay = 3600000;
                const cooldownTime = Math.min(baseDelay * Math.pow(2, failedAttempts), maxDelay);

                this.logger.warn(`Max retries exceeded for ${folderPath}, marking as failed with ${cooldownTime/1000}s cooldown`);
                await this.stateService.markFailed(folderPath, "Max retries exceeded", cooldownTime);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Read JSON file
            const files = await fs.readdir(folderPath);
            const jsonFile = files.find((file) => file.endsWith(".json"));
            if (!jsonFile) {
                this.logger.error(`No JSON file found in ${folderPath}`);
                await this.stateService.markFailed(folderPath, "No JSON file found");
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            const jsonFilePath = path.join(folderPath, jsonFile);
            let data: any;

            try {
                data = await this.fileService.readFile(jsonFilePath);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Error reading or parsing JSON file";
                this.logger.error(`${errorMessage} in ${folderPath}`);
                await this.stateService.markFailed(folderPath, errorMessage);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Validate new format with video prompts
            if (!data.video_prompts || !Array.isArray(data.video_prompts) || data.video_prompts.length === 0) {
                this.logger.error(`No video_prompts found in ${folderPath}`);
                await this.stateService.markFailed(folderPath, "No video_prompts found in JSON file");
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            // Get scene images
            const sceneImages = files.filter(file => file.match(/^scene_\d+\.png$/));
            if (data.video_prompts.length !== sceneImages.length) {
                this.logger.error(`Mismatch between video_prompts count (${data.video_prompts.length}) and scene images count (${sceneImages.length}) in ${folderPath}`);
                await this.stateService.markFailed(folderPath, "Mismatch between video_prompts and scene images count");
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (lockAcquired && !lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
                return;
            }

            this.logger.info(`Found ${data.video_prompts.length} video prompts and ${sceneImages.length} scene images in ${folderPath}`);

            // Process videos in batches of 4
            const batchSize = 4;
            const totalVideos = data.video_prompts.length;
            
            this.logger.info(`Starting batch video generation: ${totalVideos} videos in batches of ${batchSize}`);
            await this.appendWorkerLog(folderPath, `Starting batch video generation: ${totalVideos} videos in batches of ${batchSize}`);
            
            for (let batchStart = 0; batchStart < totalVideos; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, totalVideos);
                const currentBatch = batchEnd - batchStart;
                
                this.logger.info(`Processing batch ${Math.floor(batchStart / batchSize) + 1}: scenes ${batchStart} to ${batchEnd - 1} (${currentBatch} videos)`);
                await this.appendWorkerLog(folderPath, `Processing batch ${Math.floor(batchStart / batchSize) + 1}: scenes ${batchStart} to ${batchEnd - 1} (${currentBatch} videos)`);
                
                const videoPromises = [];
                
                for (let i = batchStart; i < batchEnd; i++) {
                    const videoPrompt = data.video_prompts[i];
                    const imagePath = path.join(folderPath, `scene_${i}.png`);
                    const videoPath = path.join(folderPath, `scene_${i}.mp4`);

                    // Check if image exists
                    if (!await fs.pathExists(imagePath)) {
                        this.logger.error(`Image file not found: ${imagePath}`);
                        await this.appendWorkerLog(folderPath, `Image file not found: ${imagePath}`);
                        throw new Error(`Image file not found: ${imagePath}`);
                    }

                    // Check if video already exists
                    if (await fs.pathExists(videoPath)) {
                        this.logger.info(`Video already exists for scene ${i}, skipping`);
                        await this.appendWorkerLog(folderPath, `Video already exists for scene ${i}, skipping`);
                        continue;
                    }

                    this.logger.info(`Adding scene ${i} to batch for video generation`);
                    await this.appendWorkerLog(folderPath, `Adding scene ${i} to batch for video generation`);
                    
                    const videoPromise = this.videoService.generateVideo(
                        videoPrompt.video_prompt,
                        imagePath,
                        videoPath,
                        6 // duration
                    ).then(async (videoResult) => {
                        // Save video meta to meta.json
                        const metaPath = path.join(folderPath, 'meta.json');
                        let metaArr = [];
                        if (await fs.pathExists(metaPath)) {
                            metaArr = await fs.readJson(metaPath);
                        }
                        let sceneMeta = metaArr.find((m: any) => m.scene === i);
                        if (!sceneMeta) {
                            sceneMeta = { scene: i };
                            metaArr.push(sceneMeta);
                        }
                        sceneMeta.video = videoResult;
                        await fs.writeJson(metaPath, metaArr, { spaces: 2 });

                        this.logger.info(`Successfully generated video for scene ${i}`);
                        await this.appendWorkerLog(folderPath, `Successfully generated video for scene ${i}`);
                        return { index: i, success: true };
                    }).catch(async (error) => {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        this.logger.error(`Failed to generate video for scene ${i}: ${errorMessage}`);
                        await this.appendWorkerLog(folderPath, `Failed to generate video for scene ${i}: ${errorMessage}`);
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
                    await this.appendWorkerLog(folderPath, `Batch ${Math.floor(batchStart / batchSize) + 1} completed: ${successfulCount}/${currentBatch} videos generated successfully`);
                    
                    // Check for failed generations
                    const failedResults = batchResults.filter(r => !r.success) as Array<{ index: number; success: boolean; error: string }>;
                    if (failedResults.length > 0) {
                        this.logger.warn(`Some videos failed in batch ${Math.floor(batchStart / batchSize) + 1}:`);
                        await this.appendWorkerLog(folderPath, `Some videos failed in batch ${Math.floor(batchStart / batchSize) + 1}:`);
                        failedResults.forEach(result => {
                            this.logger.warn(`  Scene ${result.index}: ❌ Failed - ${result.error}`);
                        });
                        
                        // If any video in the batch failed, throw an error to stop processing
                        throw new Error(`Batch ${Math.floor(batchStart / batchSize) + 1} failed: ${failedResults.length} videos failed`);
                    }
                }
            }

            this.logger.info(`All videos generated successfully for ${folderPath}, marking as completed`);
            await this.stateService.markCompleted(folderPath);
            try {
                if (lockAcquired && !lockReleased) {
                    await this.lockService.releaseLock(folderPath);
                    lockReleased = true;
                    this.logger.info(`Lock released for ${folderPath}`);
                }
            } catch (lockError) {
                this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
            }
            await this.fileService.moveProcessedFolder(path.basename(folderPath));

            this.logger.info(`Successfully processed new format folder: ${folderPath}`);
        } catch (error: unknown) {
            this.logger.error(`Error processing new format folder: ${folderPath}`, error);
            try {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                await this.stateService.markFailed(folderPath, errorMessage);
                await this.fileService.moveFailedFolder(path.basename(folderPath));
                try {
                    if (!lockReleased) {
                        await this.lockService.releaseLock(folderPath);
                        lockReleased = true;
                    }
                } catch (lockError) {
                    this.logger.warn(`Error releasing lock for ${folderPath}:`, lockError);
                }
            } catch (stateError) {
                this.logger.error(`Error updating state for ${folderPath}`, stateError);
            }
        } finally {
            this.activeProcesses--;
        }
    }

    /**
     * Verify that the file system state matches the state file
     * @param folderPath Path to the folder
     * @param completedScenes Array of completed scene numbers
     */
    private async verifyFileSystemState(folderPath: string, completedScenes: number[]): Promise<void> {
        this.logger.info(`Verifying file system state for ${folderPath}`);

        // Check if any scenes are marked as completed but their files don't exist
        for (const sceneNumber of completedScenes) {
            if (sceneNumber === -1) {
                // Final scene
                const finalBaseImagePath = `${folderPath}/base_final.png`;
                const finalVideoPath = `${folderPath}/scene_final.mp4`;

                if (!await fs.pathExists(finalBaseImagePath) || !await fs.pathExists(finalVideoPath)) {
                    this.logger.warn(`Final scene is marked as completed but files don't exist. Removing from completed scenes.`);
                    // Get current state
                    const state = await this.stateService.getState(folderPath);
                    if (state && state.completedScenes) {
                        // Create a new array without the scene
                        const newCompletedScenes = state.completedScenes.filter(scene => scene !== sceneNumber);
                        // Update the state with the new array
                        state.completedScenes = newCompletedScenes;
                        await this.stateService.updateState(folderPath, state);
                    }
                }
            } else {
                // Numeric scene
                const baseImagePath = `${folderPath}/base_${sceneNumber}.png`;
                const videoPath = `${folderPath}/scene_${sceneNumber}.mp4`;

                if (!await fs.pathExists(baseImagePath) || !await fs.pathExists(videoPath)) {
                    this.logger.warn(`Scene ${sceneNumber} is marked as completed but files don't exist. Removing from completed scenes.`);
                    // Get current state
                    const state = await this.stateService.getState(folderPath);
                    if (state && state.completedScenes) {
                        // Create a new array without the scene
                        const newCompletedScenes = state.completedScenes.filter(scene => scene !== sceneNumber);
                        // Update the state with the new array
                        state.completedScenes = newCompletedScenes;
                        await this.stateService.updateState(folderPath, state);
                    }
                }
            }
        }

        // Check if any scenes have files but are not marked as completed
        const files = await fs.readdir(folderPath);

        // Check for numeric scenes
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

        // Check for final scene
        if (files.includes('scene_final.mp4') && !completedScenes.includes(-1)) {
            const finalBaseImagePath = `${folderPath}/base_final.png`;

            if (await fs.pathExists(finalBaseImagePath)) {
                this.logger.warn(`Final scene has files but is not marked as completed. Marking as completed.`);
                await this.stateService.markSceneCompleted(folderPath, -1);
            }
        }
    }

    /**
     * Append a log message to the worker log file in the given folder
     */
    private async appendWorkerLog(folderPath: string, message: string, data?: unknown) {
        const logFile = path.join(folderPath, "worker.log");
        const timestamp = new Date().toISOString();
        let line = `[${timestamp}] ${message}`;
        if (data !== undefined) {
            try {
                line += " " + JSON.stringify(data);
            } catch {}
        }
        line += "\n";
        // Ensure the directory exists before writing the log
        await fs.ensureDir(folderPath);
        await fsp.appendFile(logFile, line);
    }

    /**
     * Process a single file
     * @param filePath Path to the file to process
     */
    private async processFile(filePath: string): Promise<void> {
        this.activeProcesses++;

        try {
            this.logger.info(`Processing file: ${filePath}`);
            let folderName = this.fileService.createFolderName(filePath);
            await this.appendWorkerLog(folderName, `Processing file: ${filePath}`);

            // 1. Read the file
            let data: GenerationData;

            try {
                data = await this.fileService.readFile(filePath) as GenerationData;

                // Validate the data structure
                if (!data.enhancedMedia || !Array.isArray(data.enhancedMedia) || data.enhancedMedia.length === 0) {
                    throw new Error("Invalid or empty enhancedMedia array in JSON file");
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Error reading or parsing JSON file";
                this.logger.error(`${errorMessage} in ${filePath}`);
                await this.appendWorkerLog(folderName, `${errorMessage} in ${filePath}`);
                throw new Error(errorMessage);
            }

            // 2. Create new folder
            await this.fileService.createFolder(folderName);

            // 3. Create lock and state files
            const lockAcquired = await this.lockService.acquireLock(folderName);
            if (!lockAcquired) {
                throw new Error(`Could not acquire lock for ${folderName}`);
            }

            // Initialize state
            await this.stateService.initializeState(folderName, this.lockService.getWorkerId(), this.maxRetries);

            // 4. Move original file to new folder
            const newFilePath = `${folderName}/${this.fileService.getFileName(filePath)}`;
            await this.fileService.moveFile(filePath, newFilePath);

            // 5. Filter and sort scenes for processing
            // Filter to only include numeric scenes and sort them
            const numericScenes = data.enhancedMedia
                .filter(media => typeof media.scene === 'number')
                .sort((a, b) => {
                    const sceneA = typeof a.scene === 'number' ? a.scene : Infinity;
                    const sceneB = typeof b.scene === 'number' ? b.scene : Infinity;
                    return sceneA - sceneB;
                });

            // Validate that we have at least one numeric scene
            if (numericScenes.length === 0) {
                this.logger.error(`No numeric scenes found in ${filePath}`);
                await this.appendWorkerLog(folderName, `No numeric scenes found in ${filePath}`);
                throw new Error("No numeric scenes found in JSON file");
            }

            // Find the final scene if it exists
            const finalScene = data.enhancedMedia.find(media => media.scene === 'final');

            this.logger.info(`Found ${numericScenes.length} numeric scenes and ${finalScene ? '1' : '0'} final scene in ${filePath}`);
            await this.appendWorkerLog(folderName, `Found ${numericScenes.length} numeric scenes and ${finalScene ? '1' : '0'} final scene in ${filePath}`);

            // 6. Process the first scene (scene 0)
            const firstScene = numericScenes.find(media => media.scene === 0);

            if (!firstScene) {
                this.logger.error(`No scene 0 found in file: ${filePath}`);
                await this.appendWorkerLog(folderName, `No scene 0 found in file: ${filePath}`);
                throw new Error(`No scene 0 found in file: ${filePath}`);
            }

            // Generate base image for the first scene
            const firstSceneNumber = firstScene.scene as number;
            const firstBaseImagePath = `${folderName}/base_${firstSceneNumber}.png`;
            const firstVideoPath = `${folderName}/scene_${firstSceneNumber}.mp4`;

            this.logger.info(`Generating base image for scene ${firstSceneNumber}`);
            await this.appendWorkerLog(folderName, `Generating base image for scene ${firstSceneNumber}`);
            const imageResult = await this.imageService.generateImage(firstScene.image_prompt, firstBaseImagePath);
            // Save image meta to meta.json
            const metaPathImage = path.join(folderName, `meta.json`);
            let metaImage = [];
            if (await fs.pathExists(metaPathImage)) {
                metaImage = await fs.readJson(metaPathImage);
            }
            let sceneMeta = metaImage.find((m: any) => m.scene === firstSceneNumber);
            if (!sceneMeta) {
                sceneMeta = { scene: firstSceneNumber };
                metaImage.push(sceneMeta);
            }
            sceneMeta.image = imageResult;
            await fs.writeJson(metaPathImage, metaImage, { spaces: 2 });

            this.logger.info(`Generating video for scene ${firstSceneNumber}`);
            await this.appendWorkerLog(folderName, `Generating video for scene ${firstSceneNumber}`);
            let duration = 6;
            if (firstScene.duration === 6 || firstScene.duration === 10 || firstScene.duration === "6" || firstScene.duration === "10") {
                duration = Number(firstScene.duration);
            }
            const videoResult = await this.videoService.generateVideo(firstScene.video_prompt, firstBaseImagePath, firstVideoPath, duration);
            // Save video meta to meta.json
            const metaPathVideo = path.join(folderName, `meta.json`);
            let metaVideo = [];
            if (await fs.pathExists(metaPathVideo)) {
                metaVideo = await fs.readJson(metaPathVideo);
            }
            let sceneMetaVideo = metaVideo.find((m: any) => m.scene === firstSceneNumber);
            if (!sceneMetaVideo) {
                sceneMetaVideo = { scene: firstSceneNumber };
                metaVideo.push(sceneMetaVideo);
            }
            sceneMetaVideo.video = videoResult;
            await fs.writeJson(metaPathVideo, metaVideo, { spaces: 2 });

            // 7. Process subsequent scenes
            for (let i = 1; i < numericScenes.length; i++) {
                const scene = numericScenes[i];
                const sceneNumber = scene.scene as number;
                const previousSceneNumber = sceneNumber - 1;

                // Paths for the current scene
                const baseImagePath = `${folderName}/base_${sceneNumber}.png`;
                const videoPath = `${folderName}/scene_${sceneNumber}.mp4`;

                // Path for the previous scene's video
                const previousVideoPath = `${folderName}/scene_${previousSceneNumber}.mp4`;

                this.logger.info(`Processing scene ${sceneNumber}`);
                await this.appendWorkerLog(folderName, `Processing scene ${sceneNumber}`);

                // Extract the last frame from the previous scene's video
                this.logger.info(`Extracting last frame from scene ${previousSceneNumber} video`);
                await this.appendWorkerLog(folderName, `Extracting last frame from scene ${previousSceneNumber} video`);
                await this.videoService.extractLastFrame(previousVideoPath, baseImagePath);

                // Generate video for the current scene using the extracted frame
                this.logger.info(`Generating video for scene ${sceneNumber}`);
                await this.appendWorkerLog(folderName, `Generating video for scene ${sceneNumber}`);
                let duration = 6;
                if (scene.duration === 6 || scene.duration === 10 || scene.duration === "6" || scene.duration === "10") {
                    duration = Number(scene.duration);
                }
                const videoResult = await this.videoService.generateVideo(scene.video_prompt, baseImagePath, videoPath, duration);
                // Save video meta to meta.json
                const metaPathScene = path.join(folderName, `meta.json`);
                let metaScene = [];
                if (await fs.pathExists(metaPathScene)) {
                    metaScene = await fs.readJson(metaPathScene);
                }
                let sceneMetaScene = metaScene.find((m: any) => m.scene === sceneNumber);
                if (!sceneMetaScene) {
                    sceneMetaScene = { scene: sceneNumber };
                    metaScene.push(sceneMetaScene);
                }
                sceneMetaScene.video = videoResult;
                await fs.writeJson(metaPathScene, metaScene, { spaces: 2 });
            }

            // 8. Process the final scene if it exists
            if (finalScene) {
                this.logger.info('Processing final scene');
                await this.appendWorkerLog(folderName, 'Processing final scene');

                // Get the last numeric scene
                const lastNumericScene = numericScenes[numericScenes.length - 1];
                const lastSceneNumber = lastNumericScene.scene as number;

                // Paths for the final scene
                const finalBaseImagePath = `${folderName}/base_final.png`;
                const finalVideoPath = `${folderName}/scene_final.mp4`;

                // Path for the last numeric scene's video
                const lastVideoPath = `${folderName}/scene_${lastSceneNumber}.mp4`;

                // Extract the last frame from the last numeric scene's video
                this.logger.info(`Extracting last frame from scene ${lastSceneNumber} video for final scene`);
                await this.appendWorkerLog(folderName, `Extracting last frame from scene ${lastSceneNumber} video for final scene`);
                await this.videoService.extractLastFrame(lastVideoPath, finalBaseImagePath);

                // Generate video for the final scene
                this.logger.info('Generating video for final scene');
                await this.appendWorkerLog(folderName, 'Generating video for final scene');
                let duration = 6;
                if (finalScene && (finalScene.duration === 6 || finalScene.duration === 10 || finalScene.duration === "6" || finalScene.duration === "10")) {
                    duration = Number(finalScene.duration);
                }
                const videoResult = await this.videoService.generateVideo(finalScene.video_prompt, finalBaseImagePath, finalVideoPath, duration);
                // Save video meta to meta.json
                const metaPathFinal = path.join(folderName, `meta.json`);
                let metaFinal = [];
                if (await fs.pathExists(metaPathFinal)) {
                    metaFinal = await fs.readJson(metaPathFinal);
                }
                let sceneMetaFinal = metaFinal.find((m: any) => m.scene === 'final');
                if (!sceneMetaFinal) {
                    sceneMetaFinal = { scene: 'final' };
                    metaFinal.push(sceneMetaFinal);
                }
                sceneMetaFinal.video = videoResult;
                await fs.writeJson(metaPathFinal, metaFinal, { spaces: 2 });
            }

            this.logger.info(`Successfully processed file: ${filePath}`);
            await this.appendWorkerLog(folderName, `Successfully processed file: ${filePath}`);

            // Mark processing as completed
            await this.stateService.markCompleted(folderName);

            // Release the lock
            await this.lockService.releaseLock(folderName);

            // Move the folder from in-progress to processed
            await this.fileService.moveProcessedFolder(path.basename(folderName));
        } catch (error: unknown) {
            this.logger.error(`Error processing file: ${filePath}`, error);
            let folderName = this.fileService.createFolderName(filePath);
            await this.appendWorkerLog(folderName, `Error processing file: ${filePath}`, error);

            try {
                // Create a state file for the folder to track the failure
                if (await fs.pathExists(folderName)) {
                    // Try to acquire lock for the folder
                    const lockAcquired = await this.lockService.acquireLock(folderName);

                    if (lockAcquired) {
                        // Initialize state and mark as failed
                        await this.stateService.initializeState(folderName, this.lockService.getWorkerId(), this.maxRetries);
                        const errorMessage = error instanceof Error ? error.message : "Unknown error";
                        await this.stateService.markFailed(folderName, errorMessage);
                        await this.fileService.moveFailedFolder(path.basename(folderName));
                        await this.lockService.releaseLock(folderName);
                    }
                }
            } catch (stateError) {
                this.logger.error(`Error updating state for ${filePath}`, stateError);
            }
        } finally {
            this.activeProcesses--;
        }
    }
}
/* END GENAI */