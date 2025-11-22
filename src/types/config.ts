/**
 * Configuration interface for worker parameters
 */
export interface WorkerConfig {
    workerCount: number;
    aspectRatio: '9:16' | '16:9';
    videoModel: string;
    imageModel?: string; // Optional, uses getModelForGeneration if empty
    batchSize: number;
    variantsPerScene: number;
    mainVideoDuration: number; // 6 or 10
    additionalSceneDuration: number; // 6 or 10
}

