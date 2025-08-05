import { FileService, ImageService } from './index';
import { GenerationData } from '../types';
import * as path from 'path';
import * as fs from 'fs-extra';

export class PreprocessWorker {
    private fileService = new FileService();
    private imageService = new ImageService();

    public async start(): Promise<void> {
        const unprocessedFiles = await this.fileService.getUnprocessedFiles();
        for (const filePath of unprocessedFiles) {
            await this.processFile(filePath);
        }
    }

    private async processFile(filePath: string): Promise<void> {
        // 1. Прочитать JSON
        let data: GenerationData;
        try {
            data = await this.fileService.readFile(filePath) as GenerationData;
        } catch (error) {
            console.error(`Failed to read JSON: ${filePath}`, error);
            return;
        }
        // 2. Найти первую сцену (scene: 0)
        const firstScene = data.enhancedMedia?.find((media: any) => media.scene === 0);
        if (!firstScene) {
            console.error(`No scene 0 in file: ${filePath}`);
            return;
        }
        // 3. Создать папку в in-progress (если уже есть — пропустить)
        const folderName = path.basename(filePath, path.extname(filePath));
        const folderPath = path.join(this.fileService.getInProgressDir(), folderName);
        if (await fs.pathExists(folderPath)) {
            console.warn(`Folder already exists in in-progress: ${folderPath}, skipping.`);
            return;
        }
        await this.fileService.createFolder(folderPath);
        // 4. Переместить JSON из unprocessed в папку
        const destJsonPath = path.join(folderPath, path.basename(filePath));
        await fs.move(filePath, destJsonPath, { overwrite: false });
        // 5. Генерировать 5 картинок параллельно
        const imagePromises = [];
        for (let i = 1; i <= 5; i++) {
            const imgPath = path.join(folderPath, `base_0_${i}.png`);
            imagePromises.push(this.imageService.generateImage(firstScene.image_prompt, imgPath));
        }
        await Promise.all(imagePromises);
        // 6. Перенести папку в processed
        await this.fileService.moveProcessedFolder(folderName);
    }
} 