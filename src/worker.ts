/* START GENAI */

import { FileService, ImageWorker, VideoWorker } from "./services";
import { Logger, sleep } from "./utils";

/**
 * Coordinator worker for managing content generation workflow
 * Delegates image generation to ImageWorker and video generation to VideoWorker
 */
export class ContentGenerationWorker {
    private fileService = new FileService();
    private logger = new Logger();

    private isRunning = false;

    public async start(): Promise<void> {
        this.logger.info("Starting content generation coordinator");
        this.isRunning = true;

        const imageWorker = new ImageWorker();
        const videoWorker = new VideoWorker();

        while (this.isRunning) {
            try {
                let workFound = false;

                // 1. Image Generation Phase: process JSON files and generate images
                const unprocessedFiles = await this.fileService.getUnprocessedFiles();
                if (unprocessedFiles.length > 0) {
                    this.logger.info(`Found ${unprocessedFiles.length} unprocessed JSON files, running image worker for image generation`);
                    await imageWorker.start();
                    workFound = true;
                }

                // 2. Video Generation Phase: process folders with images and JSON files for video
                const unprocessedFolders = await this.fileService.getUnprocessedFolders();
                const unprocessedFilesForVideo = await this.fileService.getUnprocessedFiles();
                
                if (unprocessedFolders.length > 0 || unprocessedFilesForVideo.length > 0) {
                    this.logger.info(`Found ${unprocessedFolders.length} unprocessed folders and ${unprocessedFilesForVideo.length} unprocessed files, running video worker for video generation`);
                    await videoWorker.start();
                    workFound = true;
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
    }

}
/* END GENAI */