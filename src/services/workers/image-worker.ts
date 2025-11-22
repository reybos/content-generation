import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { ImageService } from '../generators/image-service';
import { NewFormatWithArraysData, ContentData, ContentType } from '../../types';
import { isHalloweenFile, isHalloweenTransform, validatePromptLength, sleep } from '../../utils';
import { Logger } from '../../utils';
import * as path from 'path';
import * as fs from 'fs-extra';

interface ImageGenerationTask {
    prompt: string;
    sceneIndex: number | string;
    outputPath: string;
    variant: number;
}

interface ImageGenerationResult {
    scene: number | string;
    variant: number;
    success: boolean;
    error?: string;
}

export class ImageWorker {
    private fileService = new FileService();
    private imageService = new ImageService();
    private lockService = new LockService();
    private logger = new Logger();
    private readonly MAX_PROMPT_LENGTH = 1950;
    private readonly VARIANTS_PER_SCENE = 5;

    public async start(): Promise<void> {
        this.logger.info("Starting Universal Worker - Image Generation");
        
        while (true) {
            try {
                const unprocessedFiles = await this.fileService.getUnprocessedFiles();
                
                if (unprocessedFiles.length > 0) {
                    // Process only first file to allow other workers to pick up remaining files
                    this.logger.info(`Found ${unprocessedFiles.length} unprocessed JSON files, processing first one`);
                    await this.processFile(unprocessedFiles[0]);
                    continue;
                }

                // No files to process, wait
                this.logger.info('No files to process, waiting...');
                await sleep(25000 + Math.floor(Math.random() * 5000));
            } catch (error) {
                this.logger.error("Error in image worker loop", error);
                await sleep(10000);
            }
        }
    }


    private detectContentType(fileOrFolderPath: string): ContentType | null {
        const name = path.basename(fileOrFolderPath);
        if (isHalloweenFile(name)) {
            return ContentType.HALLOWEEN;
        }
        // Future: add checks for other types
        // if (isChristmasFile(name)) {
        //     return ContentType.CHRISTMAS;
        // }
        return null;
    }

    private async processFileWithLock(
        filePath: string,
        contentType: ContentType
    ): Promise<{ folderPath: string; folderName: string } | null> {
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Check if this folder is already being processed by a worker
        if (await fs.pathExists(folderPath)) {
            this.logger.info(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return null;
        }

        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        if (!lockAcquired) {
            this.logger.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            await fs.remove(folderPath);
            return null;
        }

        try {
            // Move JSON from unprocessed to the folder
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });
            
            return { folderPath, folderName };
        } catch (error) {
            this.logger.error(`Error setting up folder for ${contentType} file ${filePath}:`, error);
            // Clean up folder if file move failed
            try {
                await fs.remove(folderPath);
            } catch (cleanupError) {
                this.logger.error(`Failed to cleanup folder: ${folderPath}`, cleanupError);
            }
            return null;
        }
    }

    private async processFile(filePath: string): Promise<void> {
        // 1. Read JSON and determine format
        let data: ContentData;
        try {
            data = await this.fileService.readFile(filePath);
        } catch (error) {
            this.logger.error(`Failed to read JSON: ${filePath}`, error);
            return;
        }

        // 2. Determine content type
        const contentType = this.detectContentType(filePath);
        if (!contentType) {
            this.logger.error(`Unknown content type for file: ${filePath}`);
            this.logger.error(`Data: ${JSON.stringify(data)}`);
            return;
        }

        this.logger.info(`Processing ${contentType} file for image generation: ${filePath}`);

        // 3. Setup folder and lock (common logic)
        const setupResult = await this.processFileWithLock(filePath, contentType);
        if (!setupResult) {
            return; // Already logged why it failed
        }

        const { folderPath, folderName } = setupResult;

        // 4. Prepare tasks (type-specific)
        let sceneTasks: ImageGenerationTask[] = [];
        let additionalFrameTasks: ImageGenerationTask[] = [];
        
        try {
            switch (contentType) {
                case ContentType.HALLOWEEN:
                    const tasks = await this.prepareHalloweenImageTasks(folderPath, filePath, data as NewFormatWithArraysData);
                    sceneTasks = tasks.sceneTasks;
                    additionalFrameTasks = tasks.additionalFrameTasks;
                    break;
                // Future: add cases for other types
                // case ContentType.CHRISTMAS:
                //     const christmasTasks = await this.prepareChristmasImageTasks(folderPath, filePath, data);
                //     sceneTasks = christmasTasks.sceneTasks;
                //     additionalFrameTasks = christmasTasks.additionalFrameTasks;
                //     break;
                default:
                    this.logger.error(`No handler for content type: ${contentType}`);
                    await this.fileService.moveFailedFolder(folderName);
                    return;
            }
        } catch (error) {
            this.logger.error(`Error preparing tasks for ${contentType} images file ${filePath}:`, error);
            // In case of error during task preparation, move to failed
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
            return;
        }

        // 5. Process images (common logic for all types)
        try {
            await this.processImages(folderPath, folderName, filePath, sceneTasks, additionalFrameTasks);
        } catch (error) {
            this.logger.error(`Error processing ${contentType} images file ${filePath}:`, error);
            // In case of a critical error, move to failed
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        }
    }

    private async prepareHalloweenImageTasks(
        folderPath: string,
        filePath: string,
        data: NewFormatWithArraysData
    ): Promise<{ sceneTasks: ImageGenerationTask[]; additionalFrameTasks: ImageGenerationTask[] }> {
        const isHalloweenTransformFormat = isHalloweenTransform(path.basename(filePath));

        // Determine which prompts array to use based on format
        const promptsToProcess = isHalloweenTransformFormat 
            ? data.video_prompts.map((vp: any) => ({ prompt: vp.prompt, index: vp.index }))
            : data.prompts.map((p: any, idx: number) => ({ prompt: p.prompt, index: idx }));

        // Prepare tasks for main scenes
        const sceneTasks: ImageGenerationTask[] = [];
        for (let i = 0; i < promptsToProcess.length; i++) {
            const prompt = promptsToProcess[i];
            const sceneIndex = isHalloweenTransformFormat ? prompt.index : i;
            
            // Validate prompt length (no global_style - legacy removed)
            const promptValidation = validatePromptLength(prompt.prompt, this.MAX_PROMPT_LENGTH);
            if (!promptValidation.isValid) {
                throw new Error(`Scene ${sceneIndex}: ${promptValidation.error}`);
            }

            // Create variants for each scene
            for (let variant = 1; variant <= this.VARIANTS_PER_SCENE; variant++) {
                const promptFolderPath = path.join(folderPath, `scene_${sceneIndex}`);
                const imgPath = path.join(promptFolderPath, `variant_${variant}.png`);
                
                sceneTasks.push({
                    prompt: prompt.prompt, // No global_style - use prompt directly
                    sceneIndex,
                    outputPath: imgPath,
                    variant
                });
            }
        }

        // Prepare tasks for additional frames if they exist
        const additionalFrameTasks: ImageGenerationTask[] = [];
        if (data.additional_frames && data.additional_frames.length > 0) {
            for (let i = 0; i < data.additional_frames.length; i++) {
                const frame = data.additional_frames[i];
                
                // Validate prompt length
                const promptValidation = validatePromptLength(frame.group_image_prompt, this.MAX_PROMPT_LENGTH);
                if (!promptValidation.isValid) {
                    throw new Error(`Additional frame ${frame.index}: ${promptValidation.error}`);
                }

                // Create variants for each additional frame
                for (let variant = 1; variant <= this.VARIANTS_PER_SCENE; variant++) {
                    const additionalFrameFolderPath = path.join(folderPath, `additional_frame_${frame.index}`);
                    const imgPath = path.join(additionalFrameFolderPath, `variant_${variant}.png`);
                    
                    additionalFrameTasks.push({
                        prompt: frame.group_image_prompt,
                        sceneIndex: `additional_frame_${frame.index}`,
                        outputPath: imgPath,
                        variant
                    });
                }
            }
        }

        return { sceneTasks, additionalFrameTasks };
    }

    private async generateImageBatch(
        tasks: ImageGenerationTask[],
        filePath: string,
        type: 'scene' | 'additional_frame'
    ): Promise<ImageGenerationResult[]> {
        const allResults: ImageGenerationResult[] = [];
        const allErrors: Array<{ type: string; scene: number | string; variant?: number; error: string }> = [];

        this.logger.info(`Starting batch generation of ${tasks.length} image tasks for ${type}`);

        // Group tasks by scene for batching (5 second delay between batches)
        const tasksByScene = new Map<number | string, ImageGenerationTask[]>();
        for (const task of tasks) {
            if (!tasksByScene.has(task.sceneIndex)) {
                tasksByScene.set(task.sceneIndex, []);
            }
            tasksByScene.get(task.sceneIndex)!.push(task);
        }

        const scenes = Array.from(tasksByScene.keys());
        
        for (let i = 0; i < scenes.length; i++) {
            const sceneIndex = scenes[i];
            const sceneTasks = tasksByScene.get(sceneIndex)!;
            
            // Create subfolder for scene or additional frame
            const promptFolderPath = path.dirname(sceneTasks[0].outputPath);
            await this.fileService.createFolder(promptFolderPath);

            this.logger.info(`Starting ${type} ${sceneIndex}: ${sceneTasks[0].prompt.substring(0, 100)}...`);

            // Generate all variants for this scene
            const scenePromises = sceneTasks.map(task => {
                return this.imageService.generateImage(task.prompt, task.outputPath, path.basename(filePath))
                    .then(() => {
                        this.logger.info(`Successfully generated variant ${task.variant} for ${type} ${sceneIndex}`);
                        return { scene: sceneIndex, variant: task.variant, success: true };
                    })
                    .catch((error: any) => {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        this.logger.error(`Failed to generate variant ${task.variant} for ${type} ${sceneIndex}:`, error);
                        allErrors.push({ type, scene: sceneIndex, variant: task.variant, error: errorMessage });
                        return { scene: sceneIndex, variant: task.variant, success: false, error: errorMessage };
                    });
            });

            const sceneResults = await Promise.all(scenePromises);
            allResults.push(...sceneResults);

            // Add 5 second delay before next batch (except for last scene)
            if (i < scenes.length - 1) {
                this.logger.info(`Waiting 5 seconds before sending next batch...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        return allResults;
    }

    private async processImages(
        folderPath: string,
        folderName: string,
        filePath: string,
        sceneTasks: ImageGenerationTask[],
        additionalFrameTasks: ImageGenerationTask[]
    ): Promise<void> {
        const allResults: ImageGenerationResult[] = [];

        // Generate images for main scenes
        if (sceneTasks.length > 0) {
            const sceneCount = sceneTasks.length / this.VARIANTS_PER_SCENE;
            this.logger.info(`Starting batch generation of ${sceneCount} scenes with ${this.VARIANTS_PER_SCENE} variants each`);
            
            const sceneResults = await this.generateImageBatch(sceneTasks, filePath, 'scene');
            allResults.push(...sceneResults);
        }

        // Generate images for additional frames if they exist
        if (additionalFrameTasks.length > 0) {
            const additionalFrameCount = additionalFrameTasks.length / this.VARIANTS_PER_SCENE;
            this.logger.info(`Processing ${additionalFrameCount} additional frames with ${this.VARIANTS_PER_SCENE} variants each`);
            
            const additionalFrameResults = await this.generateImageBatch(additionalFrameTasks, filePath, 'additional_frame');
            allResults.push(...additionalFrameResults);
        }

        // Calculate statistics
        const totalCount = allResults.length;
        const successfulCount = allResults.filter(r => r.success).length;
        const sceneCount = sceneTasks.length / this.VARIANTS_PER_SCENE;
        const additionalFrameCount = additionalFrameTasks.length / this.VARIANTS_PER_SCENE;

        this.logger.info(`Generated ${successfulCount}/${totalCount} images successfully`);
        this.logger.info(`  Regular scenes: ${sceneCount} scenes × ${this.VARIANTS_PER_SCENE} variants = ${sceneTasks.length} images`);
        if (additionalFrameCount > 0) {
            this.logger.info(`  Additional frames: ${additionalFrameCount} frames × ${this.VARIANTS_PER_SCENE} variants = ${additionalFrameTasks.length} images`);
        }

        // Detailed logging of results by scenes
        this.logger.info('Image generation results:');
        const scenes = new Set(allResults.map(r => r.scene));
        for (const scene of scenes) {
            const sceneResults = allResults.filter(r => r.scene === scene);
            const sceneSuccessCount = sceneResults.filter(r => r.success).length;
            this.logger.info(`  ${scene}: ${sceneSuccessCount}/${this.VARIANTS_PER_SCENE} variants generated`);
            
            // Details by variants
            sceneResults.forEach(result => {
                if (result.success) {
                    this.logger.info(`    Variant ${result.variant}: ✅ Success`);
                } else {
                    this.logger.info(`    Variant ${result.variant}: ❌ Failed - ${result.error || 'Unknown error'}`);
                }
            });
        }

        // Collect errors
        const failedResults = allResults.filter(r => !r.success);
        if (failedResults.length > 0) {
            this.logger.warn(`Image generation completed with ${failedResults.length} errors:`);
            failedResults.forEach(result => {
                this.logger.warn(`  ${result.scene} variant ${result.variant}: ${result.error}`);
            });
            
            // If there are errors, move the folder to failed
            this.logger.error(`Moving folder to failed due to ${failedResults.length} errors`);
            await this.fileService.moveFailedFolder(folderName);
        } else {
            // If there are no errors, move the folder to processed (lock will be automatically removed)
            await this.fileService.moveProcessedFolder(folderName);
            this.logger.info(`Successfully processed images: ${filePath} (${successfulCount}/${totalCount} images)`);
        }
    }

}