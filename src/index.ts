/* START GENAI */

import * as dotenv from 'dotenv';
// Load environment variables from .env file
dotenv.config();

import { ContentGenerationWorker } from './worker';
import { Logger } from './utils';
import { fal } from '@fal-ai/client';

// Configure the fal.ai API key (unless in mock mode)
const logger = new Logger();
if (process.env.MOCK_API === 'true') {
    logger.info('Running in mock mode — no API key required.');
} else {
    if (!process.env.FAL_KEY) {
        logger.error('ERROR: FAL_KEY environment variable is not set. Please set it to your fal.ai API key.');
        process.exit(1);
    }

    fal.config({
        credentials: process.env.FAL_KEY
    });
}

/**
 * Main entry point for the content generation worker
 */
async function main(): Promise<void> {

    try {
        // Number of worker instances to create
        const workerCount = 5;
        logger.info(`Initializing ${workerCount} content generation workers`);

        // Create multiple worker instances
        const workers = Array.from({ length: workerCount }, () => new ContentGenerationWorker());

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            logger.info('Received SIGINT signal, shutting down...');
            workers.forEach(worker => worker.stop());
        });

        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM signal, shutting down...');
            workers.forEach(worker => worker.stop());
        });

        // Start workers with staggered initialization to prevent race conditions
        for (let i = 0; i < workers.length; i++) {
            logger.info(`Starting worker ${i + 1} of ${workers.length}`);

            // Start the worker (don't await here, we want them to run in parallel)
            const workerPromise = workers[i].start();

            // Don't wait for the last worker
            if (i < workers.length - 1) {
                // Wait 2 seconds between starting each worker
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Keep the main process running
        logger.info('All workers started');
        await new Promise(resolve => {});
    } catch (error) {
        logger.error('Fatal error in main process', error);
        process.exit(1);
    }
}

// Start the application
main().catch((error) => {
    logger.error('Unhandled error:', error);
    process.exit(1);
});

/* END GENAI */