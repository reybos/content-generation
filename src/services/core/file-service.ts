/* START GENAI */

import fs from 'fs-extra';
import path from 'path';
import { GenerationData, NewFormatData, ContentData } from '../../types';
import { LockService } from './lock-service';
import { Logger } from '../../utils';

// Helper to resolve the generations base directory
function resolveGenerationsBaseDir(): string {
    const abs = process.env.GENERATIONS_DIR_PATH;
    const rel = process.env.GENERATIONS_DIR_RELATIVE_PATH;
    if (abs && abs.trim()) {
        return abs;
    } else if (rel && rel.trim()) {
        // Project root is assumed to be process.cwd()
        return path.resolve(process.cwd(), rel);
    } else {
        return path.resolve(process.cwd(), 'generations');
    }
}

/**
 * Service for handling file operations related to content generation
 */
export class FileService {
    private baseDir: string;
    private unprocessedDir: string;
    private inProgressDir: string;
    private processedDir: string;
    private failedDir: string;
    private lockService: LockService;
    private logger: Logger;

    constructor() {
        this.baseDir = resolveGenerationsBaseDir();
        this.unprocessedDir = path.join(this.baseDir, 'unprocessed');
        this.inProgressDir = path.join(this.baseDir, 'in-progress');
        this.processedDir = path.join(this.baseDir, 'processed');
        this.failedDir = path.join(this.baseDir, 'failed');
        this.lockService = new LockService();
        this.logger = new Logger();
    }

    public getInProgressDir(): string {
        return this.inProgressDir;
    }

    public getBaseDir(): string {
        return this.baseDir;
    }

    public async getUnprocessedFiles(): Promise<string[]> {
        try {
            const files: string[] = await fs.readdir(this.unprocessedDir);
            return files
                .filter((file: string) => file.endsWith('.json'))
                .map((file: string) => path.join(this.unprocessedDir, file));
        } catch (error) {
            this.logger.error('Error reading unprocessed directory:', error);
            return [];
        }
    }

    public async getUnprocessedFolders(): Promise<string[]> {
        try {
            const entries: string[] = await fs.readdir(this.unprocessedDir);
            const folders: string[] = [];
            for (const entry of entries) {
                const entryPath = path.join(this.unprocessedDir, entry);
                if ((await fs.stat(entryPath)).isDirectory()) {
                    folders.push(entryPath);
                }
            }
            return folders;
        } catch (error) {
            this.logger.error('Error reading unprocessed directory for folders:', error);
            return [];
        }
    }

    public async readFile(filePath: string): Promise<ContentData> {
        try {
            const content: string = await fs.readFile(filePath, { encoding: 'utf-8' });
            return JSON.parse(content) as ContentData;
        } catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error}`);
        }
    }

    public async createFolder(folderPath: string): Promise<void> {
        try {
            await fs.ensureDir(folderPath);
        } catch (error) {
            throw new Error(`Failed to create folder ${folderPath}: ${error}`);
        }
    }

    public async moveProcessedFolder(folderName: string): Promise<void> {
        const sourcePath: string = path.join(this.inProgressDir, path.basename(folderName));
        const destPath: string = path.join(this.processedDir, path.basename(folderName));
        try {
            // Check if source folder exists before attempting to move
            if (!await fs.pathExists(sourcePath)) {
                this.logger.warn(`Source folder does not exist, skipping move: ${sourcePath}`);
                return;
            }

            await fs.ensureDir(this.processedDir);
            
            // Удаляем .lock файл перед перемещением папки
            await this.lockService.forceRemoveLock(sourcePath);
            
            // Double-check source still exists after lock removal
            if (!await fs.pathExists(sourcePath)) {
                this.logger.warn(`Source folder was removed during lock cleanup, skipping move: ${sourcePath}`);
                return;
            }
            
            await fs.move(sourcePath, destPath, { overwrite: true });
        } catch (error) {
            throw new Error(`Failed to move folder from ${sourcePath} to ${destPath}: ${error}`);
        }
    }
    
    public async moveFailedFolder(folderName: string): Promise<void> {
        const sourcePath = path.join(this.inProgressDir, path.basename(folderName));
        const destPath = path.join(this.failedDir, path.basename(folderName));
        try {
            // Check if source folder exists before attempting to move
            if (!await fs.pathExists(sourcePath)) {
                this.logger.warn(`Source folder does not exist, skipping move: ${sourcePath}`);
                return;
            }

            await fs.ensureDir(this.failedDir);
            
            // Удаляем .lock файл перед перемещением папки
            await this.lockService.forceRemoveLock(sourcePath);
            
            // Double-check source still exists after lock removal
            if (!await fs.pathExists(sourcePath)) {
                this.logger.warn(`Source folder was removed during lock cleanup, skipping move: ${sourcePath}`);
                return;
            }
            
            await fs.move(sourcePath, destPath, { overwrite: true});
        } catch (error) {
            throw new Error(`Failed to move folder from ${sourcePath} to ${destPath}: ${error}`);
        }
    }
}

/* END GENAI */