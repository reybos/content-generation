/* START GENAI */

import { GenerationData } from "./types";
import { FileService, ImageService, VideoService, LockService, StateService, ImageWorker, VideoWorker } from "./services";
import { Logger, sleep } from "./utils";
import * as path from "path";
import * as fs from "fs-extra";
import { promises as fsp } from "fs";

/**
 * Coordinator worker for managing content generation workflow
 * Delegates image generation to ImageWorker and video generation to VideoWorker
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
        this.logger.info("Starting content generation coordinator");
        this.isRunning = true;

        const imageWorker = new ImageWorker();
        const videoWorker = new VideoWorker();

        while (this.isRunning) {
            try {
                let workFound = false;

                // 1. Image Generation Phase: обрабатываем JSON файлы и генерируем картинки
                const unprocessedFiles = await this.fileService.getUnprocessedFiles();
                if (unprocessedFiles.length > 0) {
                    this.logger.info(`Found ${unprocessedFiles.length} unprocessed JSON files, running image worker for image generation`);
                    await imageWorker.start();
                    workFound = true;
                }

                // 2. Video Generation Phase: обрабатываем папки с картинками и JSON файлы для видео
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                const unprocessedFilesForVideo = await this.fileService.getUnprocessedFiles();
                
                if (unprocessedFolders.length > 0 || unprocessedFilesForVideo.length > 0) {
                    this.logger.info(`Found ${unprocessedFolders.length} unprocessed folders and ${unprocessedFilesForVideo.length} unprocessed files, running video worker for video generation`);
                    await videoWorker.start();
                    workFound = true;
                }

                // Если работы не было, ждем
                if (!workFound) {
                    this.logger.info('No work to process, waiting...');
                    const jitter = Math.floor(Math.random() * 5000);
                    await sleep(25000 + jitter);
                }
            } catch (error) {
                this.logger.error("Error in coordinator loop", error);
                await sleep(10000);
            }
        }
    }

    public stop(): void {
        this.logger.info("Stopping content generation coordinator");
        this.isRunning = false;
    }

    /**
     * Process a single file (legacy method - kept for backward compatibility)
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
}
/* END GENAI */