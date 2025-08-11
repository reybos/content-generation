import { UniversalWorker, VideoWorker, FileService, ImageService, VideoService, LockService, StateService } from './services';

/**
 * Test to verify the new structured organization works correctly
 */
async function testStructure() {
    console.log('🧪 Testing new services structure...\n');

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
        
        console.log('\n🎉 All structure tests passed! New organization is working correctly.');
        
    } catch (error) {
        console.error('❌ Structure test failed:', error);
        process.exit(1);
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    testStructure().catch(console.error);
}

export { testStructure };
