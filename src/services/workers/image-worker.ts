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
        // 1. Прочитать JSON и определить формат
        let data: ContentData;
        try {
            data = await this.fileService.readFile(filePath);
        } catch (error) {
            this.logger.error(`Failed to read JSON: ${filePath}`, error);
            return;
        }

        // 2. Определить формат и обработать соответственно
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
        
        // Проверяем, не обрабатывается ли уже эта папка воркером
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
            // Переместить JSON из unprocessed в папку
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });

            // Determine which prompts array to use based on format
            const isHalloweenTransformFormat = isHalloweenTransform(data, path.basename(filePath));
            const promptsToProcess = isHalloweenTransformFormat 
                ? data.video_prompts.map((vp: any) => ({ prompt: vp.prompt, index: vp.index }))
                : data.prompts.map((p: any, idx: number) => ({ prompt: p.prompt, index: idx }));

            // Генерировать картинки пачками по 5 с интервалом в 5 секунд между отправкой пачек
            this.logger.info(`Starting batch generation of ${promptsToProcess.length} prompts with 5 variants each for SongWithAnimal`);
            
            const allPromises = [];
            const allErrors: Array<{ type: string; scene: number | string; variant?: number; error: string }> = [];
            
            for (let i = 0; i < promptsToProcess.length; i++) {
                const prompt = promptsToProcess[i];
                const combinedPrompt = isHalloweenTransformFormat 
                    ? prompt.prompt 
                    : `${data.global_style} \n ${prompt.prompt}`;
                
                // Создаем подпапку для каждого промпта
                const sceneIndex = isHalloweenTransformFormat ? prompt.index : i;
                const promptFolderPath = path.join(folderPath, `scene_${sceneIndex}`);
                await this.fileService.createFolder(promptFolderPath);
                
                this.logger.info(`Starting scene ${sceneIndex}: ${prompt.prompt}`);
                
                // Генерируем 5 вариантов для каждого промпта пачкой
                for (let variant = 1; variant <= 5; variant++) {
                    const imgPath = path.join(promptFolderPath, `variant_${variant}.png`);
                    
                    const imagePromise = this.imageService.generateImage(combinedPrompt, imgPath, 'isSongWithAnimal', path.basename(filePath))
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
                
                // Добавляем задержку в 5 секунд перед отправкой следующей пачки
                if (i < promptsToProcess.length - 1) {
                    this.logger.info(`Waiting 5 seconds before sending next batch...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
            
            // Обрабатываем additional_frames если они есть
            if (data.additional_frames && data.additional_frames.length > 0) {
                this.logger.info(`Processing ${data.additional_frames.length} additional frames with 5 variants each`);
                
                for (let i = 0; i < data.additional_frames.length; i++) {
                    const frame = data.additional_frames[i];
                    const combinedPrompt = `${frame.group_image_prompt}`;
                    
                    this.logger.info(`Starting additional frame ${frame.index}: ${frame.group_image_prompt.substring(0, 100)}...`);
                    
                    // Генерируем 5 вариантов для каждого additional frame в корне папки
                    for (let variant = 1; variant <= 5; variant++) {
                        const imgPath = path.join(folderPath, `additional_frame_${frame.index}_${variant}.png`);
                        
                        const imagePromise = this.imageService.generateImage(combinedPrompt, imgPath, 'isSongWithAnimal', path.basename(filePath))
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
                    
                    // Добавляем задержку в 5 секунд перед отправкой следующего additional frame
                    if (i < data.additional_frames.length - 1) {
                        this.logger.info(`Waiting 5 seconds before sending next additional frame...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }

            // Ждем завершения всех генераций
            this.logger.info(`All batches sent. Waiting for completion...`);
            const imageResults = await Promise.all(allPromises);

            // Проверяем, сколько изображений удалось сгенерировать
            const regularImagesCount = promptsToProcess.length * 5; // 5 вариантов для каждого промпта
            const additionalImagesCount = data.additional_frames ? data.additional_frames.length * 5 : 0; // 5 вариантов для каждого additional frame
            const totalCount = regularImagesCount + additionalImagesCount;
            const successfulCount = imageResults.filter((r: any) => r.success).length;
            
            this.logger.info(`Generated ${successfulCount}/${totalCount} images successfully for SongWithAnimal`);
            this.logger.info(`  Regular scenes: ${promptsToProcess.length} scenes × 5 variants = ${regularImagesCount} images`);
            if (data.additional_frames) {
                this.logger.info(`  Additional frames: ${data.additional_frames.length} frames × 5 variants = ${additionalImagesCount} images`);
            }
            
            // Детальное логирование результатов по сценам
            this.logger.info('Image generation results:');
            for (let i = 0; i < promptsToProcess.length; i++) {
                const sceneIndex = isHalloweenTransformFormat ? promptsToProcess[i].index : i;
                const sceneResults = imageResults.filter((r: any) => r.scene === sceneIndex);
                const sceneSuccessCount = sceneResults.filter((r: any) => r.success).length;
                this.logger.info(`  Scene ${sceneIndex}: ${sceneSuccessCount}/5 variants generated`);
                
                // Детали по вариантам
                sceneResults.forEach((result: any) => {
                    if (result.success) {
                        this.logger.info(`    Variant ${result.variant}: ✅ Success`);
                    } else {
                        this.logger.info(`    Variant ${result.variant}: ❌ Failed - ${result.error || 'Unknown error'}`);
                    }
                });
            }
            
            // Логирование результатов по additional frames
            if (data.additional_frames) {
                for (let i = 0; i < data.additional_frames.length; i++) {
                    const frame = data.additional_frames[i];
                    const frameResults = imageResults.filter((r: any) => r.scene === `additional_frame_${frame.index}`);
                    const frameSuccessCount = frameResults.filter((r: any) => r.success).length;
                    this.logger.info(`  Additional Frame ${frame.index}: ${frameSuccessCount}/5 variants generated`);
                    
                    // Детали по вариантам
                    frameResults.forEach((result: any) => {
                        if (result.success) {
                            this.logger.info(`    Variant ${result.variant}: ✅ Success`);
                        } else {
                            this.logger.info(`    Variant ${result.variant}: ❌ Failed - ${result.error || 'Unknown error'}`);
                        }
                    });
                }
            }
            
            // Принимаем решение о судьбе папки на основе собранных ошибок
            if (allErrors.length > 0) {
                this.logger.warn(`Image generation completed with ${allErrors.length} errors:`);
                allErrors.forEach(error => {
                    if (error.variant) {
                        this.logger.warn(`  ${error.type} ${error.scene} variant ${error.variant}: ${error.error}`);
                    } else {
                        this.logger.warn(`  ${error.type} ${error.scene}: ${error.error}`);
                    }
                });
                
                // Если есть ошибки, перемещаем папку в failed
                this.logger.error(`Moving folder to failed due to ${allErrors.length} errors`);
                await this.fileService.moveFailedFolder(folderName);
            } else {
                // Если нет ошибок, перенести папку в processed (блокировка будет автоматически удалена)
                await this.fileService.moveProcessedFolder(folderName);
                this.logger.info(`Successfully processed song with animal images: ${filePath} (${successfulCount}/${totalCount} images)`);
            }
        } catch (error) {
            this.logger.error(`Error processing song with animal images file ${filePath}:`, error);
            
            // В случае критической ошибки (не связанной с генерацией изображений) перемещаем в failed
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
        
        // Проверяем, не обрабатывается ли уже эта папка воркером
        if (await fs.pathExists(folderPath)) {
            this.logger.info(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }

        // Создаем папку ПЕРЕД получением блокировки
        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        if (!lockAcquired) {
            this.logger.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            // Удаляем созданную папку если не удалось получить блокировку
            await fs.remove(folderPath);
            return;
        }

        try {
            // Переместить JSON из unprocessed в папку
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });
            
            // Генерировать 5 картинок параллельно
            const imagePromises = [];
            for (let i = 1; i <= 5; i++) {
                const imgPath = path.join(folderPath, `base_0_${i}.png`);
                imagePromises.push(this.imageService.generateImage(firstScene.image_prompt, imgPath, 'isStudy', path.basename(filePath)));
            }
            await Promise.all(imagePromises);
            
            // Перенести папку в processed (блокировка будет автоматически удалена)
            await this.fileService.moveProcessedFolder(folderName);
            
            this.logger.info(`Successfully processed study format file: ${filePath}`);
        } catch (error) {
            this.logger.error(`Error processing study format file ${filePath}:`, error);
            
            // В случае ошибки перемещаем в failed (блокировка будет автоматически удалена)
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                this.logger.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        }
    }




}