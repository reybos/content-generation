import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { ImageService } from '../generators/image-service';
import { GenerationData, NewFormatWithArraysData, ContentData } from '../../types';
import { isSingleVideoFormat, isSongWithAnimal, isStudy, isHalloweenTransform } from '../../utils';
import { Logger } from '../../utils';
import * as path from 'path';
import * as fs from 'fs-extra';

export class ImageWorker {
    private fileService = new FileService();
    private imageService = new ImageService();
    private lockService = new LockService();
    private logger = new Logger();

    public async start(): Promise<void> {
        this.logger.info("Starting Universal Worker - Image Generation");
        const unprocessedFiles = await this.fileService.getUnprocessedFiles();
        
        if (unprocessedFiles.length === 0) {
            this.logger.info("No unprocessed JSON files found for image generation");
            return;
        }

        this.logger.info(`Found ${unprocessedFiles.length} unprocessed JSON files for image generation`);
        
        for (const filePath of unprocessedFiles) {
            await this.processFile(filePath);
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

        // 2. Determine format and process accordingly
        this.logger.info(`Processing file for image generation: ${filePath}`);
        
        if (isSongWithAnimal(data) || isHalloweenTransform(data, path.basename(filePath))) {
            this.logger.info(`Генерация картинок. Шортсы с животными по формату "The X says X"`);
            await this.processSongWithAnimalImages(filePath, data as NewFormatWithArraysData);

        } else if (isStudy(data)) {
            this.logger.info(`Генерация картинок. Формат обучения, с одним базовым изображением и связанным сюжетом`);
            await this.processStudyImages(filePath, data as GenerationData);
        } else if (isSingleVideoFormat(data)) {
            this.logger.info(`Файл в формате single video (song + video_prompt), пропускаем - это для video worker`);
            return;
        } else {
            this.logger.error(`Unknown format for file: ${filePath}`);
            this.logger.error(`Data: ${JSON.stringify(data)}`);
        }
    }

    private async processSongWithAnimalImages(filePath: string, data: NewFormatWithArraysData): Promise<void> {
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

            // Determine which prompts array to use based on format
            const isHalloweenTransformFormat = isHalloweenTransform(data, path.basename(filePath));
            const promptsToProcess = isHalloweenTransformFormat 
                ? data.video_prompts.map((vp: any) => ({ prompt: vp.prompt, index: vp.index }))
                : data.prompts.map((p: any, idx: number) => ({ prompt: p.prompt, index: idx }));

            // Generate images in batches of 5 with 5 second intervals between batch submissions
            this.logger.info(`Starting batch generation of ${promptsToProcess.length} prompts with 5 variants each for SongWithAnimal`);
            
            const allPromises = [];
            const allErrors: Array<{ type: string; scene: number | string; variant?: number; error: string }> = [];
            
            for (let i = 0; i < promptsToProcess.length; i++) {
                const prompt = promptsToProcess[i];
                const combinedPrompt = isHalloweenTransformFormat 
                    ? prompt.prompt 
                    : `${data.global_style} \n ${prompt.prompt}`;
                
                // Create a subfolder for each prompt
                const sceneIndex = isHalloweenTransformFormat ? prompt.index : i;
                const promptFolderPath = path.join(folderPath, `scene_${sceneIndex}`);
                await this.fileService.createFolder(promptFolderPath);
                
                this.logger.info(`Starting scene ${sceneIndex}: ${prompt.prompt}`);
                
                // Generate 5 variants for each prompt in a batch
                for (let variant = 1; variant <= 5; variant++) {
                    const imgPath = path.join(promptFolderPath, `variant_${variant}.png`);
                    
                    const imagePromise = this.imageService.generateImage(combinedPrompt, imgPath, path.basename(filePath))
                        .then(() => {
                            this.logger.info(`Successfully generated variant ${variant} for scene ${sceneIndex}`);
                            return { scene: sceneIndex, variant, success: true };
                        })
                        .catch((error: any) => {
                            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                            this.logger.error(`Failed to generate variant ${variant} for scene ${sceneIndex}:`, error);
                            allErrors.push({ type: 'scene', scene: sceneIndex, variant, error: errorMessage });
                            return { scene: sceneIndex, variant, success: false, error: errorMessage };
                        });
                    
                    allPromises.push(imagePromise);
                }
                
                // Add a 5 second delay before sending the next batch
                if (i < promptsToProcess.length - 1) {
                    this.logger.info(`Waiting 5 seconds before sending next batch...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
            
            // Process additional_frames if they exist
            if (data.additional_frames && data.additional_frames.length > 0) {
                this.logger.info(`Processing ${data.additional_frames.length} additional frames with 5 variants each`);
                
                for (let i = 0; i < data.additional_frames.length; i++) {
                    const frame = data.additional_frames[i];
                    const combinedPrompt = `${frame.group_image_prompt}`;
                    
                    this.logger.info(`Starting additional frame ${frame.index}: ${frame.group_image_prompt.substring(0, 100)}...`);
                    
                    // Generate 5 variants for each additional frame in the root folder
                    for (let variant = 1; variant <= 5; variant++) {
                        const imgPath = path.join(folderPath, `additional_frame_${frame.index}_${variant}.png`);
                        
                        const imagePromise = this.imageService.generateImage(combinedPrompt, imgPath, path.basename(filePath))
                            .then(() => {
                                this.logger.info(`Successfully generated additional frame ${frame.index} variant ${variant}`);
                                return { scene: `additional_frame_${frame.index}`, variant, success: true };
                            })
                            .catch((error: any) => {
                                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                                this.logger.error(`Failed to generate additional frame ${frame.index} variant ${variant}:`, error);
                                allErrors.push({ type: 'additional_frame', scene: `additional_frame_${frame.index}`, variant, error: errorMessage });
                                return { scene: `additional_frame_${frame.index}`, variant, success: false, error: errorMessage };
                            });
                        
                        allPromises.push(imagePromise);
                    }
                    
                    // Add a 5 second delay before sending the next additional frame
                    if (i < data.additional_frames.length - 1) {
                        this.logger.info(`Waiting 5 seconds before sending next additional frame...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }

            // Wait for all generations to complete
            this.logger.info(`All batches sent. Waiting for completion...`);
            const imageResults = await Promise.all(allPromises);

            // Check how many images were successfully generated
            const regularImagesCount = promptsToProcess.length * 5; // 5 variants for each prompt
            const additionalImagesCount = data.additional_frames ? data.additional_frames.length * 5 : 0; // 5 variants for each additional frame
            const totalCount = regularImagesCount + additionalImagesCount;
            const successfulCount = imageResults.filter((r: any) => r.success).length;
            
            this.logger.info(`Generated ${successfulCount}/${totalCount} images successfully for SongWithAnimal`);
            this.logger.info(`  Regular scenes: ${promptsToProcess.length} scenes × 5 variants = ${regularImagesCount} images`);
            if (data.additional_frames) {
                this.logger.info(`  Additional frames: ${data.additional_frames.length} frames × 5 variants = ${additionalImagesCount} images`);
            }
            
            // Detailed logging of results by scenes
            this.logger.info('Image generation results:');
            for (let i = 0; i < promptsToProcess.length; i++) {
                const sceneIndex = isHalloweenTransformFormat ? promptsToProcess[i].index : i;
                const sceneResults = imageResults.filter((r: any) => r.scene === sceneIndex);
                const sceneSuccessCount = sceneResults.filter((r: any) => r.success).length;
                this.logger.info(`  Scene ${sceneIndex}: ${sceneSuccessCount}/5 variants generated`);
                
                // Details by variants
                sceneResults.forEach((result: any) => {
                    if (result.success) {
                        this.logger.info(`    Variant ${result.variant}: ✅ Success`);
                    } else {
                        this.logger.info(`    Variant ${result.variant}: ❌ Failed - ${result.error || 'Unknown error'}`);
                    }
                });
            }
            
            // Logging results for additional frames
            if (data.additional_frames) {
                for (let i = 0; i < data.additional_frames.length; i++) {
                    const frame = data.additional_frames[i];
                    const frameResults = imageResults.filter((r: any) => r.scene === `additional_frame_${frame.index}`);
                    const frameSuccessCount = frameResults.filter((r: any) => r.success).length;
                    this.logger.info(`  Additional Frame ${frame.index}: ${frameSuccessCount}/5 variants generated`);
                    
                    // Details by variants
                    frameResults.forEach((result: any) => {
                        if (result.success) {
                            this.logger.info(`    Variant ${result.variant}: ✅ Success`);
                        } else {
                            this.logger.info(`    Variant ${result.variant}: ❌ Failed - ${result.error || 'Unknown error'}`);
                        }
                    });
                }
            }
            
            // Make a decision about the folder's fate based on collected errors
            if (allErrors.length > 0) {
                this.logger.warn(`Image generation completed with ${allErrors.length} errors:`);
                allErrors.forEach(error => {
                    if (error.variant) {
                        this.logger.warn(`  ${error.type} ${error.scene} variant ${error.variant}: ${error.error}`);
                    } else {
                        this.logger.warn(`  ${error.type} ${error.scene}: ${error.error}`);
                    }
                });
                
                // If there are errors, move the folder to failed
                this.logger.error(`Moving folder to failed due to ${allErrors.length} errors`);
                await this.fileService.moveFailedFolder(folderName);
            } else {
                // If there are no errors, move the folder to processed (lock will be automatically removed)
                await this.fileService.moveProcessedFolder(folderName);
                this.logger.info(`Successfully processed song with animal images: ${filePath} (${successfulCount}/${totalCount} images)`);
            }
        } catch (error) {
            this.logger.error(`Error processing song with animal images file ${filePath}:`, error);
            
            // In case of a critical error (not related to image generation) move to failed
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        }
    }

    private async processStudyImages(filePath: string, data: GenerationData): Promise<void> {
        const firstScene = data.enhancedMedia?.find((media: any) => media.scene === 0);
        if (!firstScene) {
            this.logger.error(`No scene 0 in file: ${filePath}`);
            return;
        }
        
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Check if this folder is already being processed by a worker
        if (await fs.pathExists(folderPath)) {
            this.logger.info(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }

        // Create folder BEFORE acquiring lock
        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        if (!lockAcquired) {
            this.logger.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            // Remove the created folder if we couldn't acquire the lock
            await fs.remove(folderPath);
            return;
        }

        try {
            // Move JSON from unprocessed to the folder
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });
            
            // Generate 5 images in parallel
            const imagePromises = [];
            for (let i = 1; i <= 5; i++) {
                const imgPath = path.join(folderPath, `base_0_${i}.png`);
                imagePromises.push(this.imageService.generateImage(firstScene.image_prompt, imgPath, path.basename(filePath)));
            }
            await Promise.all(imagePromises);
            
            // Move folder to processed (lock will be automatically removed)
            await this.fileService.moveProcessedFolder(folderName);
            
            this.logger.info(`Successfully processed study format file: ${filePath}`);
        } catch (error) {
            this.logger.error(`Error processing study format file ${filePath}:`, error);
            
            // In case of error, move to failed (lock will be automatically removed)
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        }
    }




}