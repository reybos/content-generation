/**
 * Example usage of the refactored content generation system
 *
 * The system now has clear separation of concerns:
 * 1. UniversalWorker - handles image generation from JSON files
 * 2. VideoWorker - handles video generation from folders with images
 * 3. ContentGenerationWorker - coordinates the workflow between workers
 */
declare function runImageWorkerOnly(): Promise<void>;
declare function runVideoWorkerOnly(): Promise<void>;
declare function runCoordinatedWorkflow(): Promise<void>;
export { runImageWorkerOnly, runVideoWorkerOnly, runCoordinatedWorkflow };
