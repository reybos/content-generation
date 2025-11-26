import { FileService } from '../core/file-service';
import { ImageService, ImageGenerationTask, ImageGenerationResult } from '../generators/image-service';
import { ContentData, ContentType, WorkerConfig } from '../../types';
import { isHalloweenFile, isPoemsFile, sleep } from '../../utils';
import { Logger } from '../../utils';
import * as path from 'path';

export class ImageWorker {
    private fileService = new FileService();
    private imageService: ImageService;
    private logger = new Logger();
    private readonly VARIANTS_PER_SCENE: number;

    constructor(config?: Partial<WorkerConfig>) {
        this.VARIANTS_PER_SCENE = config?.variantsPerScene ?? 5;
        this.imageService = new ImageService(config);
    }

    private detectContentType(fileOrFolderPath: string): ContentType | null {
        const name = path.basename(fileOrFolderPath);
        if (isHalloweenFile(name)) {
            return ContentType.HALLOWEEN;
        }
        if (isPoemsFile(name)) {
            return ContentType.POEMS;
        }
        return null;
    }

    public async processFile(filePath: string): Promise<void> {
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
        const setupResult = await this.fileService.processFileWithLock(filePath, contentType);
        if (!setupResult) {
            return; // Already logged why it failed
        }

        const { folderPath, folderName } = setupResult;

        // 4. Prepare tasks (type-specific)
        let sceneTasks: ImageGenerationTask[] = [];
        let groupFrameTasks: ImageGenerationTask[] = [];
        let additionalFrameTasks: ImageGenerationTask[] = [];
        
        try {
            const tasks = await this.imageService.prepareImageTasks(contentType, folderPath, filePath, data);
            sceneTasks = tasks.sceneTasks;
            groupFrameTasks = tasks.groupFrameTasks || [];
            additionalFrameTasks = tasks.additionalFrameTasks || [];
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
            await this.processImages(folderPath, folderName, filePath, sceneTasks, groupFrameTasks, additionalFrameTasks);
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


    private async processImages(
        folderPath: string,
        folderName: string,
        filePath: string,
        sceneTasks: ImageGenerationTask[],
        groupFrameTasks: ImageGenerationTask[],
        additionalFrameTasks: ImageGenerationTask[] = []
    ): Promise<void> {
        const allResults: ImageGenerationResult[] = [];

        // Generate images for main scenes
        if (sceneTasks.length > 0) {
            const sceneCount = sceneTasks.length / this.VARIANTS_PER_SCENE;
            this.logger.info(`Starting batch generation of ${sceneCount} scenes with ${this.VARIANTS_PER_SCENE} variants each`);
            
            const sceneResults = await this.imageService.generateImageBatch(sceneTasks, filePath, 'scene');
            allResults.push(...sceneResults);
        }

        // Generate images for group frames if they exist
        if (groupFrameTasks.length > 0) {
            const groupFrameCount = groupFrameTasks.length / this.VARIANTS_PER_SCENE;
            this.logger.info(`Processing ${groupFrameCount} group frames with ${this.VARIANTS_PER_SCENE} variants each`);
            
            const groupFrameResults = await this.imageService.generateImageBatch(groupFrameTasks, filePath, 'group_frame');
            allResults.push(...groupFrameResults);
        }

        // Generate images for additional frames if they exist
        if (additionalFrameTasks.length > 0) {
            const additionalFrameCount = additionalFrameTasks.length / this.VARIANTS_PER_SCENE;
            this.logger.info(`Processing ${additionalFrameCount} additional frames with ${this.VARIANTS_PER_SCENE} variants each`);
            
            const additionalFrameResults = await this.imageService.generateImageBatch(additionalFrameTasks, filePath, 'additional_frame');
            allResults.push(...additionalFrameResults);
        }

        // Calculate statistics
        const totalCount = allResults.length;
        const successfulCount = allResults.filter(r => r.success).length;
        const sceneCount = sceneTasks.length / this.VARIANTS_PER_SCENE;
        const groupFrameCount = groupFrameTasks.length / this.VARIANTS_PER_SCENE;
        const additionalFrameCount = additionalFrameTasks.length / this.VARIANTS_PER_SCENE;

        this.logger.info(`Generated ${successfulCount}/${totalCount} images successfully`);
        this.logger.info(`  Regular scenes: ${sceneCount} scenes × ${this.VARIANTS_PER_SCENE} variants = ${sceneTasks.length} images`);
        if (groupFrameCount > 0) {
            this.logger.info(`  Group frames: ${groupFrameCount} frames × ${this.VARIANTS_PER_SCENE} variants = ${groupFrameTasks.length} images`);
        }
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