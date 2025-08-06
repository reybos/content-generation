import { FileService, ImageService, LockService, VideoService } from './index';
import { GenerationData, NewFormatData, NewFormatWithVideoData, ContentData } from '../types';
import * as path from 'path';
import * as fs from 'fs-extra';

export class UniversalWorker {
    private fileService = new FileService();
    private imageService = new ImageService();
    private videoService = new VideoService();
    private lockService = new LockService();

    public async start(): Promise<void> {
        const unprocessedFiles = await this.fileService.getUnprocessedFiles();
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
        console.log(`Processing file: ${filePath}`);
        console.log(`File has video_prompts: ${!!(data as any).video_prompts}`);
        console.log(`File has prompts: ${!!(data as any).prompts}`);
        console.log(`File has enhancedMedia: ${!!(data as any).enhancedMedia}`);
        
        if (this.isNewFormatWithVideo(data)) {
            const folderName = path.basename(filePath, path.extname(filePath));
            
            // Проверяем, есть ли папка уже в in-progress
            const inProgressFolderPath = path.join(this.fileService.getInProgressDir(), folderName);
            const unprocessedFolderPath = path.join(this.fileService.getUnprocessedDir(), folderName);
            
            let imageFiles: string[] = [];
            let imageCount = 0;
            
            if (await fs.pathExists(inProgressFolderPath)) {
                // Папка уже в in-progress, проверяем изображения там
                const files = await fs.readdir(inProgressFolderPath);
                imageFiles = files.filter(file => file.match(/^scene_\d+\.png$/));
                imageCount = imageFiles.length;
                console.log(`Found ${imageCount} images in in-progress folder: ${folderName}`);
            } else if (await fs.pathExists(unprocessedFolderPath)) {
                // Папка в unprocessed, проверяем изображения там
                imageFiles = await this.getImageFilesFromUnprocessed(folderName);
                imageCount = imageFiles.length;
                console.log(`Found ${imageCount} images in unprocessed folder: ${folderName}`);
            }
            
            const videoPromptsCount = (data as any).video_prompts?.length || 0;
            
            if (imageCount === videoPromptsCount && videoPromptsCount > 0) {
                console.log(`Detected as NewFormatWithVideo (found ${imageCount} images, will generate videos)`);
                await this.processNewFormatWithVideo(filePath, data as NewFormatWithVideoData);
            } else {
                console.log(`Detected as NewFormatWithVideo (no images found, will generate images first)`);
                await this.processNewFormat(filePath, data as NewFormatData);
            }
        } else if (this.isOldFormat(data)) {
            console.log(`Detected as OldFormat`);
            await this.processOldFormat(filePath, data as GenerationData);
        } else {
            console.error(`Unknown format for file: ${filePath}`);
        }
    }

    private async processNewFormatWithVideo(filePath: string, data: NewFormatWithVideoData): Promise<void> {
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Проверяем, не обрабатывается ли уже эта папка воркером
        if (await fs.pathExists(folderPath)) {
            console.log(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }
        
        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        let lockReleased = false;
        if (!lockAcquired) {
            console.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            await fs.remove(folderPath);
            return;
        }

        try {
            // Переместить JSON из unprocessed в папку
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });

            // Переместить изображения из unprocessed в папку
            const unprocessedFolderPath = path.join(this.fileService.getUnprocessedDir(), folderName);
            if (await fs.pathExists(unprocessedFolderPath)) {
                const files = await fs.readdir(unprocessedFolderPath);
                for (const file of files) {
                    if (file.match(/^scene_\d+\.png$/)) {
                        const sourcePath = path.join(unprocessedFolderPath, file);
                        const destPath = path.join(folderPath, file);
                        await fs.move(sourcePath, destPath, { overwrite: false });
                    }
                }
                // Удаляем пустую папку из unprocessed
                const remainingFiles = await fs.readdir(unprocessedFolderPath);
                if (remainingFiles.length === 0) {
                    await fs.remove(unprocessedFolderPath);
                }
            }

            // Генерировать видео батчами по 4 штуки параллельно
            const batchSize = 4;
            const totalVideos = data.video_prompts.length;
            
            console.log(`Starting batch video generation: ${totalVideos} videos in batches of ${batchSize}`);
            
            for (let batchStart = 0; batchStart < totalVideos; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, totalVideos);
                const currentBatch = batchEnd - batchStart;
                
                console.log(`Processing batch ${Math.floor(batchStart / batchSize) + 1}: scenes ${batchStart} to ${batchEnd - 1} (${currentBatch} videos)`);
                
                const videoPromises = [];
                
                for (let i = batchStart; i < batchEnd; i++) {
                    const videoPrompt = data.video_prompts[i];
                    const imagePath = path.join(folderPath, `scene_${i}.png`);
                    const videoPath = path.join(folderPath, `scene_${i}.mp4`);

                    // Проверяем, что изображение существует
                    if (!await fs.pathExists(imagePath)) {
                        console.error(`Image file not found: ${imagePath}`);
                        throw new Error(`Image file not found: ${imagePath}`);
                    }

                    // Проверяем, не сгенерировано ли уже видео
                    if (await fs.pathExists(videoPath)) {
                        console.log(`Video already exists for scene ${i}, skipping`);
                        continue;
                    }

                    console.log(`Adding scene ${i} to batch for video generation`);
                    
                    const videoPromise = this.videoService.generateVideo(
                        videoPrompt.video_prompt, 
                        imagePath, 
                        videoPath, 
                        6 // duration
                    ).then((videoResult) => {
                        // Сохраняем метаданные видео
                        const metaPath = path.join(folderPath, 'meta.json');
                        return fs.readJson(metaPath).then((metaArr) => {
                            let sceneMeta = metaArr.find((m: any) => m.scene === i);
                            if (!sceneMeta) {
                                sceneMeta = { scene: i };
                                metaArr.push(sceneMeta);
                            }
                            sceneMeta.video = videoResult;
                            return fs.writeJson(metaPath, metaArr, { spaces: 2 });
                        }).then(() => {
                            console.log(`Successfully generated video for scene ${i}`);
                            return { index: i, success: true };
                        });
                    }).catch((error) => {
                        console.error(`Failed to generate video for scene ${i}:`, error);
                        return { index: i, success: false, error: error instanceof Error ? error.message : 'Unknown error' };
                    });
                    
                    videoPromises.push(videoPromise);
                }
                
                // Ждем завершения текущего батча
                if (videoPromises.length > 0) {
                    const batchResults = await Promise.all(videoPromises);
                    
                    // Логируем результаты батча
                    const successfulCount = batchResults.filter(r => r.success).length;
                    console.log(`Batch ${Math.floor(batchStart / batchSize) + 1} completed: ${successfulCount}/${currentBatch} videos generated successfully`);
                    
                    // Проверяем, есть ли неудачные генерации
                    const failedResults = batchResults.filter(r => !r.success) as Array<{ index: number; success: boolean; error: string }>;
                    if (failedResults.length > 0) {
                        console.warn(`Some videos failed in batch ${Math.floor(batchStart / batchSize) + 1}:`);
                        failedResults.forEach(result => {
                            console.warn(`  Scene ${result.index}: ❌ Failed - ${result.error}`);
                        });
                    }
                }
            }

            // Перенести папку в processed
            await this.fileService.moveProcessedFolder(folderName);
            
            console.log(`Successfully processed new format with video file: ${filePath}`);
        } catch (error) {
            console.error(`Error processing new format with video file ${filePath}:`, error);
            
            // В случае ошибки перемещаем в failed
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                console.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        } finally {
            try {
                if (lockAcquired && !lockReleased) {
                    await this.lockService.releaseLock(folderPath);
                    lockReleased = true;
                }
            } catch (lockError) {
                console.warn(`Error releasing lock for ${folderPath}:`, lockError);
            }
        }
    }

    private async getImageFilesFromUnprocessed(folderName: string): Promise<string[]> {
        const unprocessedFolderPath = path.join(this.fileService.getUnprocessedDir(), folderName);
        if (!await fs.pathExists(unprocessedFolderPath)) {
            return [];
        }

        const files = await fs.readdir(unprocessedFolderPath);
        return files.filter(file => file.match(/^scene_\d+\.png$/));
    }

    private async processNewFormat(filePath: string, data: NewFormatData): Promise<void> {
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        
        // Проверяем, не обрабатывается ли уже эта папка воркером
        if (await fs.pathExists(folderPath)) {
            console.log(`Folder ${folderName} already exists in in-progress, skipping to avoid conflicts with worker processing`);
            return;
        }

        await this.fileService.createFolder(folderPath);

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        let lockReleased = false;
        if (!lockAcquired) {
            console.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            await fs.remove(folderPath);
            return;
        }

        try {
            // Переместить JSON из unprocessed в папку
            const destJsonPath = path.join(folderPath, path.basename(filePath));
            await fs.move(filePath, destJsonPath, { overwrite: false });

            // Генерировать картинки для всех элементов из prompts параллельно
            console.log(`Starting batch generation of ${data.prompts.length} images`);
            
            const imagePromises = [];
            for (let i = 0; i < data.prompts.length; i++) {
                const prompt = data.prompts[i];
                const combinedPrompt = `${prompt.prompt}, ${data.global_style}`;
                const imgPath = path.join(folderPath, `scene_${i}.png`);
                
                const imagePromise = this.imageService.generateImage(combinedPrompt, imgPath)
                    .then(() => {
                        console.log(`Successfully generated image for scene ${i}`);
                        return { index: i, success: true };
                    })
                    .catch((error) => {
                        console.error(`Failed to generate image for scene ${i}:`, error);
                        return { index: i, success: false, error: error instanceof Error ? error.message : 'Unknown error' };
                    });
                
                imagePromises.push(imagePromise);
            }
            
            // Ждем завершения всех генераций
            const imageResults = await Promise.all(imagePromises);

            // Проверяем, сколько изображений удалось сгенерировать
            const successfulCount = imageResults.filter(r => r.success).length;
            const totalCount = data.prompts.length;
            
            console.log(`Generated ${successfulCount}/${totalCount} images successfully`);
            
            // Детальное логирование результатов
            console.log('Image generation results:');
            imageResults.forEach((result, index) => {
                if (result.success) {
                    console.log(`  Scene ${index}: ✅ Success`);
                } else {
                    console.log(`  Scene ${index}: ❌ Failed - ${(result as any).error || 'Unknown error'}`);
                }
            });
            
            // Если хотя бы одно изображение сгенерировано, считаем обработку успешной
            if (successfulCount > 0) {
                // Перенести папку в processed
                await this.fileService.moveProcessedFolder(folderName);
                console.log(`Successfully processed new format file: ${filePath} (${successfulCount}/${totalCount} images)`);
            } else {
                // Если ни одно изображение не сгенерировано, перемещаем в failed
                throw new Error(`Failed to generate any images (0/${totalCount})`);
            }
        } catch (error) {
            console.error(`Error processing new format file ${filePath}:`, error);
            
            // В случае ошибки перемещаем в failed
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                console.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        } finally {
            try {
                if (lockAcquired && !lockReleased) {
                    await this.lockService.releaseLock(folderPath);
                    lockReleased = true;
                }
            } catch (lockError) {
                console.warn(`Error releasing lock for ${folderPath}:`, lockError);
            }
        }
    }

    private async processOldFormat(filePath: string, data: GenerationData): Promise<void> {
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

        const lockAcquired = await this.lockService.acquireLock(folderPath);
        let lockReleased = false;
        if (!lockAcquired) {
            console.warn(`Could not acquire lock for folder: ${folderPath}, skipping.`);
            return;
        }

        try {
            // Создаем папку
            await this.fileService.createFolder(folderPath);
            
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
            
            // Перенести папку в processed
            await this.fileService.moveProcessedFolder(folderName);
            
            console.log(`Successfully processed old format file: ${filePath}`);
        } catch (error) {
            console.error(`Error processing old format file ${filePath}:`, error);
            
            // В случае ошибки перемещаем в failed
            try {
                await this.fileService.moveFailedFolder(folderName);
            } catch (moveError) {
                console.error(`Failed to move folder to failed: ${folderName}`, moveError);
            }
        } finally {
            try {
                if (lockAcquired && !lockReleased) {
                    await this.lockService.releaseLock(folderPath);
                    lockReleased = true;
                }
            } catch (lockError) {
                console.warn(`Error releasing lock for ${folderPath}:`, lockError);
            }
        }
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
               data.character && 
               Array.isArray(data.enhancedMedia) && 
               data.enhancedMedia.length > 0;
    }
} 