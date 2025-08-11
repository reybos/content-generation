"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runImageWorkerOnly = runImageWorkerOnly;
exports.runVideoWorkerOnly = runVideoWorkerOnly;
exports.runCoordinatedWorkflow = runCoordinatedWorkflow;
const services_1 = require("../../src/services");
/**
 * Example usage of the refactored content generation system
 *
 * The system now has clear separation of concerns:
 * 1. UniversalWorker - handles image generation from JSON files
 * 2. VideoWorker - handles video generation from folders with images
 * 3. ContentGenerationWorker - coordinates the workflow between workers
 */
async function runImageWorkerOnly() {
    console.log('=== Running Image Generation Only ===');
    const imageWorker = new services_1.UniversalWorker();
    await imageWorker.start();
}
async function runVideoWorkerOnly() {
    console.log('=== Running Video Generation Only ===');
    const videoWorker = new services_1.VideoWorker();
    await videoWorker.start();
}
async function runCoordinatedWorkflow() {
    console.log('=== Running Coordinated Workflow ===');
    const coordinator = new services_1.ContentGenerationWorker();
    await coordinator.start();
}
async function main() {
    // Choose one of the following approaches:
    // Option 1: Run only image generation
    // await runImageWorkerOnly();
    // Option 2: Run only video generation  
    // await runVideoWorkerOnly();
    // Option 3: Run the full coordinated workflow (recommended)
    await runCoordinatedWorkflow();
}
// Run the example
if (require.main === module) {
    main().catch(console.error);
}
//# sourceMappingURL=example-usage.js.map