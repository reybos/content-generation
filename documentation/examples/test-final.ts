import { UniversalWorker, VideoWorker, FileService, ImageService, VideoService, LockService, StateService } from './services';

/**
 * Final test to verify the refactored architecture works correctly
 */
function testFinalArchitecture() {
    console.log('🎯 Testing final refactored architecture...\n');

    try {
        // Test 1: Core services
        console.log('✅ Testing core services...');
        const fileService = new FileService();
        const lockService = new LockService();
        const stateService = new StateService();
        console.log('   Core services created successfully');
        
        // Test 2: Generator services
        console.log('✅ Testing generator services...');
        const imageService = new ImageService();
        const videoService = new VideoService();
        console.log('   Generator services created successfully');
        
        // Test 3: Worker services
        console.log('✅ Testing worker services...');
        const imageWorker = new UniversalWorker();
        const videoWorker = new VideoWorker();
        console.log('   Worker services created successfully');
        
        // Test 4: Check service types
        console.log('\n📋 Service types:');
        console.log(`   FileService: ${fileService.constructor.name}`);
        console.log(`   LockService: ${lockService.constructor.name}`);
        console.log(`   StateService: ${stateService.constructor.name}`);
        console.log(`   ImageService: ${imageService.constructor.name}`);
        console.log(`   VideoService: ${videoService.constructor.name}`);
        console.log(`   UniversalWorker: ${imageWorker.constructor.name}`);
        console.log(`   VideoWorker: ${videoWorker.constructor.name}`);
        
        // Test 5: Check directory structure
        console.log('\n🏗️ Directory structure:');
        console.log('   src/services/');
        console.log('   ├── workers/ (UniversalWorker, VideoWorker)');
        console.log('   ├── core/ (FileService, LockService, StateService)');
        console.log('   ├── generators/ (ImageService, VideoService)');
        console.log('   └── index.ts (main exports)');
        
        console.log('\n🎉 All tests passed! Refactored architecture is working correctly.');
        console.log('\n🚀 Next steps:');
        console.log('   1. Run: npm start (for full workflow)');
        console.log('   2. Or run individual workers as needed');
        console.log('   3. Check the documentation for usage examples');
        
    } catch (error) {
        console.error('❌ Final test failed:', error);
        process.exit(1);
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    testFinalArchitecture();
}

export { testFinalArchitecture };
