const fs = require('fs-extra');
const path = require('path');

async function cleanupDuplicates() {
    const baseDir = '/Users/andrejbosyj/Documents/projects/generate/generations';
    const failedDir = path.join(baseDir, 'failed');
    const inProgressDir = path.join(baseDir, 'in-progress');

    console.log('Starting cleanup of duplicate folders...');

    try {
        // Get all folders in failed directory
        const failedFolders = await fs.readdir(failedDir);
        
        for (const folderName of failedFolders) {
            const failedFolderPath = path.join(failedDir, folderName);
            const inProgressFolderPath = path.join(inProgressDir, folderName);
            
            // Check if folder exists in both directories
            if (await fs.pathExists(inProgressFolderPath)) {
                console.log(`Found duplicate folder: ${folderName}`);
                
                // Check which folder has more content
                const failedStats = await fs.stat(failedFolderPath);
                const inProgressStats = await fs.stat(inProgressFolderPath);
                
                const failedFiles = await fs.readdir(failedFolderPath);
                const inProgressFiles = await fs.readdir(inProgressFolderPath);
                
                console.log(`  Failed folder has ${failedFiles.length} files`);
                console.log(`  In-progress folder has ${inProgressFiles.length} files`);
                
                // If in-progress has more files (like generated images), keep it and remove from failed
                if (inProgressFiles.length > failedFiles.length) {
                    console.log(`  Keeping in-progress folder (more content), removing from failed`);
                    await fs.remove(failedFolderPath);
                } else {
                    console.log(`  Keeping failed folder, removing from in-progress`);
                    await fs.remove(inProgressFolderPath);
                }
            }
        }
        
        console.log('Cleanup completed successfully!');
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
}

cleanupDuplicates(); 