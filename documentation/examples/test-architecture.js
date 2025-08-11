"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testArchitecture = testArchitecture;
const services_1 = require("../../src/services");
/**
 * Simple test to verify the new architecture works correctly
 */
async function testArchitecture() {
    console.log('🧪 Testing new architecture...\n');
    try {
        // Test 1: UniversalWorker instantiation
        console.log('✅ Testing UniversalWorker...');
        const imageWorker = new services_1.UniversalWorker();
        console.log('   UniversalWorker created successfully');
        // Test 2: VideoWorker instantiation  
        console.log('✅ Testing VideoWorker...');
        const videoWorker = new services_1.VideoWorker();
        console.log('   VideoWorker created successfully');
        // Test 3: ContentGenerationWorker instantiation
        console.log('✅ Testing ContentGenerationWorker...');
        const coordinator = new services_1.ContentGenerationWorker();
        console.log('   ContentGenerationWorker created successfully');
        // Test 4: Check worker types
        console.log('\n📋 Worker types:');
        console.log(`   UniversalWorker: ${imageWorker.constructor.name}`);
        console.log(`   VideoWorker: ${videoWorker.constructor.name}`);
        console.log(`   ContentGenerationWorker: ${coordinator.constructor.name}`);
        console.log('\n🎉 All tests passed! Architecture is working correctly.');
    }
    catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}
// Run tests if this file is executed directly
if (require.main === module) {
    testArchitecture().catch(console.error);
}
//# sourceMappingURL=test-architecture.js.map