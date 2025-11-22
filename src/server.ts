/* START GENAI */

import * as dotenv from 'dotenv';
// Load environment variables from .env file
dotenv.config();

import express from 'express';
import path from 'path';
import { WorkerConfig } from './types';
import { Logger } from './utils';
import { ContentGenerationWorker } from './worker';
import { fal } from '@fal-ai/client';

const logger = new Logger();

// Configure the fal.ai API key
if (!process.env.FAL_KEY) {
    logger.error('ERROR: FAL_KEY environment variable is not set. Please set it to your fal.ai API key.');
    process.exit(1);
}

fal.config({
    credentials: process.env.FAL_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Store running workers
let workers: ContentGenerationWorker[] = [];
let isRunning = false;

// API Routes
app.post('/api/start', async (req, res) => {
    try {
        if (isRunning) {
            return res.status(400).json({ error: 'Workers are already running. Please stop them first.' });
        }

        const config: WorkerConfig = {
            workerCount: parseInt(req.body.workerCount) || 2,
            aspectRatio: req.body.aspectRatio || '9:16',
            videoModel: req.body.videoModel || 'fal-ai/minimax/hailuo-02/standard/image-to-video',
            imageModel: req.body.imageModel || undefined,
            batchSize: parseInt(req.body.batchSize) || 12,
            variantsPerScene: parseInt(req.body.variantsPerScene) || 5,
            mainVideoDuration: parseInt(req.body.mainVideoDuration) || 6,
            additionalSceneDuration: parseInt(req.body.additionalSceneDuration) || 10,
        };

        // Validate durations
        if (config.mainVideoDuration !== 6 && config.mainVideoDuration !== 10) {
            return res.status(400).json({ error: 'Main video duration must be 6 or 10' });
        }
        if (config.additionalSceneDuration !== 6 && config.additionalSceneDuration !== 10) {
            return res.status(400).json({ error: 'Additional scene duration must be 6 or 10' });
        }

        logger.info('Starting workers with config:', config);
        
        // Set isRunning first so status endpoint returns correct value
        isRunning = true;
        
        // Create workers directly
        const workerCount = config.workerCount;
        workers = Array.from({ length: workerCount }, () => new ContentGenerationWorker(config));
        
        // Start workers in background (don't await, let them run async)
        for (let i = 0; i < workers.length; i++) {
            logger.info(`Starting worker ${i + 1} of ${workers.length}`);
            workers[i].start().catch((error) => {
                logger.error(`Error starting worker ${i + 1}:`, error);
                // If worker fails to start, we might want to reset isRunning
                // But for now, let's keep it running
            });
            
            // Stagger worker starts
            if (i < workers.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        logger.info('All workers started');

        res.json({ 
            success: true, 
            message: 'Workers started successfully',
            config 
        });
    } catch (error) {
        logger.error('Error in /api/start:', error);
        res.status(500).json({ 
            error: 'Failed to start workers', 
            message: error instanceof Error ? error.message : 'Unknown error' 
        });
    }
});

app.post('/api/stop', (req, res) => {
    try {
        if (!isRunning) {
            return res.status(400).json({ error: 'No workers are currently running' });
        }

        logger.info('Stopping workers...');
        
        const workerCount = workers.length;
        
        // Stop all workers
        workers.forEach((worker, index) => {
            try {
                logger.info(`Stopping worker ${index + 1} of ${workerCount}`);
                worker.stop();
                logger.info(`Worker ${index + 1} stopped successfully`);
            } catch (error) {
                logger.error(`Error stopping worker ${index + 1}:`, error);
            }
        });
        
        isRunning = false;
        workers = [];
        
        logger.info(`All ${workerCount} workers stopped successfully`);

        res.json({ success: true, message: 'Workers stopped successfully' });
    } catch (error) {
        logger.error('Error in /api/stop:', error);
        res.status(500).json({ 
            error: 'Failed to stop workers', 
            message: error instanceof Error ? error.message : 'Unknown error' 
        });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ 
        isRunning,
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    logger.info(`Worker Configuration UI server running on http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Received SIGINT signal, shutting down server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM signal, shutting down server...');
    process.exit(0);
});

/* END GENAI */

