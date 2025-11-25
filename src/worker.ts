/* START GENAI */

import { FileService, ImageWorker, VideoWorker } from "./services";
import { Logger, sleep, isPoemsDirectVideoFile } from "./utils";
import { WorkerConfig } from "./types";

/**
 * Coordinator worker for managing content generation workflow
 * Delegates image generation to ImageWorker and video generation to VideoWorker
 */
export class ContentGenerationWorker {
    private fileService = new FileService();
    private logger = new Logger();
    private config?: Partial<WorkerConfig>;

    private isRunning = false;

    constructor(config?: Partial<WorkerConfig>) {
        this.config = config;
    }

    public async start(): Promise<void> {
        this.logger.info("Starting content generation coordinator");
        this.isRunning = true;

        const imageWorker = new ImageWorker(this.config);
        const videoWorker = new VideoWorker(this.config);

        while (this.isRunning) {
            try {
                let workFound = false;

                // 1. Direct Video Poems Phase: process direct-video poems files (skip image generation)
                const allUnprocessedFiles = await this.fileService.getUnprocessedFiles();
                const directVideoFiles = allUnprocessedFiles.filter(file => {
                    const fileName = file.split(/[/\\]/).pop() || '';
                    return isPoemsDirectVideoFile(fileName);
                });
                
                if (directVideoFiles.length > 0) {
                    this.logger.info(`Found ${directVideoFiles.length} direct-video poems files, processing first one`);
                    await videoWorker.processDirectVideoFile(directVideoFiles[0]);
                    workFound = true;
                }

                // 2. Image Generation Phase: process JSON files and generate images (excluding direct-video files)
                const regularFiles = allUnprocessedFiles.filter(file => {
                    const fileName = file.split(/[/\\]/).pop() || '';
                    return !isPoemsDirectVideoFile(fileName);
                });
                
                if (regularFiles.length > 0) {
                    this.logger.info(`Found ${regularFiles.length} unprocessed JSON files, processing first one`);
                    await imageWorker.processFile(regularFiles[0]);
                    workFound = true;
                }

                // 3. Video Generation Phase: process folders with images and JSON files for video
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                
                if (unprocessedFolders.length > 0) {
                    const folderMatch = videoWorker.findFolderByType(unprocessedFolders);
                    if (folderMatch) {
                        this.logger.info(`Found ${folderMatch.type} folder for video generation: ${folderMatch.folder}`);
                        await videoWorker.processFolder(folderMatch.folder, folderMatch.type);
                        workFound = true;
                    }
                }

                // If there was no work, wait
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
        this.logger.info("Content generation coordinator stopped");
    }

}
/* END GENAI */