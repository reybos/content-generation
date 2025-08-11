import { FileService } from '../core/file-service';
import { LockService } from '../core/lock-service';
import { ImageService } from '../generators/image-service';
import { GenerationData, NewFormatData, NewFormatWithVideoData, NewFormatWithArraysData, ContentData } from '../../types';
import * as path from 'path';
import * as fs from 'fs-extra';

export class UniversalWorker {
    private fileService = new FileService();
    private imageService = new ImageService();
    private lockService = new LockService();

    public async start(): Promise<void> {
        console.log("Starting Universal Worker - Image Generation");
        const unprocessedFiles = await this.fileService.getUnprocessedFiles();
        
        if (unprocessedFiles.length === 0) {
            console.log("No unprocessed JSON files found for image generation");
            return;
        }

        console.log(`Found ${unprocessedFiles.length} unprocessed JSON files for image generation`);
        
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
            console.error(`Failed to read JSON: ${filePath}`, error);
            return;
        }

        // 2. Определить формат и обработать соответственно
        console.log(`Processing file for image generation: ${filePath}`);
        
        if (this.isNewFormatWithArrays(data)) {
            console.log(`Генерация картинок. Шортсы с животными по формату "The X says X"`);
            await this.processNewFormatWithArraysImages(filePath, data as NewFormatWithArraysData);

        } else if (this.isOldFormat(data)) {
            console.log(`Генерация картинок. Самый первый формат, с одним базовым изображением и связанным сюжетом`);
            await this.processOldFormatImages(filePath, data as GenerationData);
        } else {
            console.error(`Unknown format for file: ${filePath}`);
            console.error(`Data: ${JSON.stringify(data)}`);
        }
    }

    private async processNewFormatWithArraysImages(filePath: string, data: NewFormatWithArraysData): Promise<void> {
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Проверяем, не обрабатывается ли уже эта папка воркером
        if (await fs.pathExists(folderPath)) {
            console.log(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }

        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        if (!lockAcquired) {
            console.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            await fs.remove(folderPath);
            return;
        }

        try {
            // Переместить JSON из unprocessed в папку
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });

            // Генерировать картинки пачками по 5 с интервалом в 5 секунд между отправкой пачек
            console.log(`Starting batch generation of ${data.prompts.length} prompts with 5 variants each for NewFormatWithArrays`);
            
            const allPromises = [];
            
            for (let i = 0; i < data.prompts.length; i++) {
                const prompt = data.prompts[i];
                const combinedPrompt = `${prompt.prompt}, ${data.global_style}`;
                
                // Создаем подпапку для каждого промпта
                const promptFolderPath = path.join(folderPath, `scene_${i}`);
                await this.fileService.createFolder(promptFolderPath);
                
                console.log(`Starting scene ${i}: ${prompt.prompt}`);
                
                // Генерируем 5 вариантов для каждого промпта пачкой
                for (let variant = 1; variant <= 5; variant++) {
                    const imgPath = path.join(promptFolderPath, `variant_${variant}.png`);
                    
                    const imagePromise = this.imageService.generateImage(combinedPrompt, imgPath)
                        .then(() => {
                            console.log(`Successfully generated variant ${variant} for scene ${i}`);
                            return { scene: i, variant, success: true };
                        })
                        .catch((error: any) => {
                            console.error(`Failed to generate variant ${variant} for scene ${i}:`, error);
                            return { scene: i, variant, success: false, error: error instanceof Error ? error.message : 'Unknown error' };
                        });
                    
                    allPromises.push(imagePromise);
                }
                
                // Добавляем задержку в 5 секунд перед отправкой следующей пачки
                if (i < data.prompts.length - 1) {
                    console.log(`Waiting 5 seconds before sending next batch...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
            
            // Ждем завершения всех генераций
            console.log(`All batches sent. Waiting for completion...`);
            const imageResults = await Promise.all(allPromises);

            // Проверяем, сколько изображений удалось сгенерировать
            const successfulCount = imageResults.filter((r: any) => r.success).length;
            const totalCount = data.prompts.length * 5; // 5 вариантов для каждого промпта
            
            console.log(`Generated ${successfulCount}/${totalCount} images successfully for NewFormatWithArrays`);
            
            // Детальное логирование результатов по сценам
            console.log('Image generation results:');
            for (let i = 0; i < data.prompts.length; i++) {
                const sceneResults = imageResults.filter((r: any) => r.scene === i);
                const sceneSuccessCount = sceneResults.filter((r: any) => r.success).length;
                console.log(`  Scene ${i}: ${sceneSuccessCount}/5 variants generated`);
                
                // Детали по вариантам
                sceneResults.forEach((result: any) => {
                    if (result.success) {
                        console.log(`    Variant ${result.variant}: ✅ Success`);
                    } else {
                        console.log(`    Variant ${result.variant}: ❌ Failed - ${result.error || 'Unknown error'}`);
                    }
                });
            }
            
            // Если хотя бы одно изображение сгенерировано, считаем обработку успешной
            if (successfulCount > 0) {
                // Перенести папку в processed (блокировка будет автоматически удалена)
                await this.fileService.moveProcessedFolder(folderName);
                console.log(`Successfully processed new format with arrays images: ${filePath} (${successfulCount}/${totalCount} images)`);
            } else {
                // Если ни одно изображение не сгенерировано, перемещаем в failed (блокировка будет автоматически удалена)
                throw new Error(`Failed to generate any images (0/${totalCount})`);
            }
        } catch (error) {
            console.error(`Error processing new format with arrays images file ${filePath}:`, error);
            
            // В случае ошибки перемещаем в failed (блокировка будет автоматически удалена)
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                console.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        }
    }

    private async processOldFormatImages(filePath: string, data: GenerationData): Promise<void> {
        const firstScene = data.enhancedMedia?.find((media: any) => media.scene === 0);
        if (!firstScene) {
            console.error(`No scene 0 in file: ${filePath}`);
            return;
        }
        
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Проверяем, не обрабатывается ли уже эта папка воркером
        if (await fs.pathExists(folderPath)) {
            console.log(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }

        // Создаем папку ПЕРЕД получением блокировки
        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        if (!lockAcquired) {
            console.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
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
                imagePromises.push(this.imageService.generateImage(firstScene.image_prompt, imgPath));
            }
            await Promise.all(imagePromises);
            
            // Перенести папку в processed (блокировка будет автоматически удалена)
            await this.fileService.moveProcessedFolder(folderName);
            
            console.log(`Successfully processed old format file: ${filePath}`);
        } catch (error) {
            console.error(`Error processing old format file ${filePath}:`, error);
            
            // В случае ошибки перемещаем в failed (блокировка будет автоматически удалена)
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                console.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        }
    }

    private isNewFormatWithArrays(data: any): data is NewFormatWithArraysData {
        return data && 
               typeof data.global_style === 'string' && 
               Array.isArray(data.prompts) && 
               data.prompts.length > 0 &&
               Array.isArray(data.video_prompts) && 
               data.video_prompts.length > 0 &&
               Array.isArray(data.titles) &&
               Array.isArray(data.descriptions) &&
               Array.isArray(data.hashtags);
    }

    private isNewFormatWithVideo(data: any): data is NewFormatWithVideoData {
        return data && 
               typeof data.global_style === 'string' && 
               Array.isArray(data.prompts) && 
               data.prompts.length > 0 &&
               Array.isArray(data.video_prompts) && 
               data.video_prompts.length > 0 &&
               typeof data.title === 'string' &&
               typeof data.description === 'string' &&
               typeof data.hashtags === 'string';
    }

    private isOldFormat(data: any): data is GenerationData {
        return data && 
               data.script &&
               data.narration &&
               Array.isArray(data.enhancedMedia) && 
               data.enhancedMedia.length > 0;
    }
}