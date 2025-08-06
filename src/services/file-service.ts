/* START GENAI */

import fs from 'fs-extra';
import path from 'path';
import { GenerationData, NewFormatData, ContentData } from '../types';

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

    constructor() {
        this.baseDir = resolveGenerationsBaseDir();
        this.unprocessedDir = path.join(this.baseDir, 'unprocessed');
        this.inProgressDir = path.join(this.baseDir, 'in-progress');
        this.processedDir = path.join(this.baseDir, 'processed');
        this.failedDir = path.join(this.baseDir, 'failed');
    }

    public getUnprocessedDir(): string {
        return this.unprocessedDir;
    }
    public getInProgressDir(): string {
        return this.inProgressDir;
    }
    public getProcessedDir(): string {
        return this.processedDir;
    }
    public getFailedDir(): string {
        return this.failedDir;
    }
    public async getUnprocessedFiles(): Promise<string[]> {
        try {
            const files: string[] = await fs.readdir(this.unprocessedDir);
            return files
                .filter((file: string) => file.endsWith('.json'))
                .map((file: string) => path.join(this.unprocessedDir, file));
        } catch (error) {
            console.error('Error reading unprocessed directory:', error);
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
            console.error('Error reading unprocessed directory for folders:', error);
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
    public createFolderName(filePath: string): string {
        const fileName: string = path.basename(filePath, path.extname(filePath));
        return path.join(this.inProgressDir, fileName);
    }
    public async createFolder(folderPath: string): Promise<void> {
        try {
            await fs.ensureDir(folderPath);
        } catch (error) {
            throw new Error(`Failed to create folder ${folderPath}: ${error}`);
        }
    }
    public async moveFile(source: string, destination: string): Promise<void> {
        try {
            const destDir: string = path.dirname(destination);
            await fs.ensureDir(destDir);
            await fs.move(source, destination, { overwrite: true });
        } catch (error) {
            throw new Error(`Failed to move file from ${source} to ${destination}: ${error}`);
        }
    }
    public getFileName(filePath: string): string {
        return path.basename(filePath);
    }
    public async moveProcessedFolder(folderName: string): Promise<void> {
        const sourcePath: string = path.join(this.inProgressDir, path.basename(folderName));
        const destPath: string = path.join(this.processedDir, path.basename(folderName));
        try {
            await fs.ensureDir(this.processedDir);
            await fs.move(sourcePath, destPath, { overwrite: true });
        } catch (error) {
            throw new Error(`Failed to move folder from ${sourcePath} to ${destPath}: ${error}`);
        }
    }
    public async moveFailedFolder(folderName: string): Promise<void> {
        const sourcePath = path.join(this.inProgressDir, path.basename(folderName));
        const destPath = path.join(this.failedDir, path.basename(folderName));
        try {
            await fs.ensureDir(this.failedDir);
            await fs.move(sourcePath, destPath, { overwrite: true});
        } catch (error) {
            throw new Error(`Failed to move folder from ${sourcePath} to ${destPath}: ${error}`);
        }
    }
}

/* END GENAI */