// Form elements
const form = document.getElementById('configForm');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusText = document.getElementById('statusText');
const statusIndicator = document.getElementById('statusIndicator');
const useCustomImageModel = document.getElementById('useCustomImageModel');
const customImageModelGroup = document.getElementById('customImageModelGroup');
const videoModelSelect = document.getElementById('videoModel');
const customVideoModelGroup = document.getElementById('customVideoModelGroup');
const customVideoModelInput = document.getElementById('customVideoModel');

// Toggle custom image model input
useCustomImageModel.addEventListener('change', () => {
    customImageModelGroup.style.display = useCustomImageModel.checked ? 'block' : 'none';
});

// Toggle custom video model input
videoModelSelect.addEventListener('change', () => {
    customVideoModelGroup.style.display = videoModelSelect.value === 'custom' ? 'block' : 'none';
    if (videoModelSelect.value !== 'custom') {
        customVideoModelInput.value = '';
    }
});

// Check status on load
checkStatus();

// Poll status every 2 seconds
setInterval(checkStatus, 2000);

// Form submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        workerCount: parseInt(document.getElementById('workerCount').value),
        aspectRatio: document.getElementById('aspectRatio').value,
        videoModel: videoModelSelect.value === 'custom' 
            ? customVideoModelInput.value 
            : videoModelSelect.value,
        imageModel: useCustomImageModel.checked 
            ? document.getElementById('imageModel').value || undefined
            : undefined,
        batchSize: parseInt(document.getElementById('batchSize').value),
        variantsPerScene: parseInt(document.getElementById('variantsPerScene').value),
        mainVideoDuration: parseInt(document.getElementById('mainVideoDuration').value),
        additionalSceneDuration: parseInt(document.getElementById('additionalSceneDuration').value),
    };

    // Validate aspect ratio is selected
    const aspectRatio = document.getElementById('aspectRatio').value;
    if (!aspectRatio) {
        alert('Please select an Image Aspect Ratio');
        document.getElementById('aspectRatio').focus();
        return;
    }

    // Validate custom video model if selected
    if (videoModelSelect.value === 'custom' && !customVideoModelInput.value.trim()) {
        alert('Please enter a custom video model or select a preset model');
        return;
    }

    try {
        startButton.disabled = true;
        startButton.textContent = 'Starting...';

        const response = await fetch('/api/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(formData),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to start workers');
        }

        // Workers started successfully - updateStatus will handle button states
        // Force immediate status update
        await checkStatus();
        alert('Workers started successfully!');
    } catch (error) {
        alert('Error: ' + (error.message || 'Failed to start workers'));
        console.error('Error starting workers:', error);
        // Reset button only on error
        startButton.disabled = false;
        startButton.textContent = 'Start Workers';
    }
});

// Stop button
stopButton.addEventListener('click', async () => {
    try {
        stopButton.disabled = true;
        stopButton.textContent = 'Stopping...';

        const response = await fetch('/api/stop', {
            method: 'POST',
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to stop workers');
        }

        // Workers stopped successfully - updateStatus will handle button states
        // Force immediate status update
        await checkStatus();
        alert('Workers stopped successfully!');
    } catch (error) {
        alert('Error: ' + (error.message || 'Failed to stop workers'));
        console.error('Error stopping workers:', error);
        // Reset button only on error
        stopButton.disabled = false;
        stopButton.textContent = 'Stop Workers';
    }
});

// Check status
async function checkStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        updateStatus(data.isRunning);
    } catch (error) {
        console.error('Error checking status:', error);
    }
}

// Update UI based on status
function updateStatus(isRunning) {
    if (isRunning) {
        statusText.textContent = 'Workers Running';
        statusIndicator.className = 'status-indicator running';
        startButton.disabled = true;
        startButton.textContent = 'Start Workers';
        // Disable all form inputs except stop button
        const formInputs = form.querySelectorAll('input, select');
        formInputs.forEach(input => {
            input.disabled = true;
        });
        stopButton.disabled = false;
        stopButton.textContent = 'Stop Workers';
        stopButton.style.pointerEvents = 'auto';
        form.style.opacity = '0.6';
        form.style.pointerEvents = 'none';
    } else {
        statusText.textContent = 'Ready';
        statusIndicator.className = 'status-indicator stopped';
        startButton.disabled = false;
        startButton.textContent = 'Start Workers';
        // Enable all form inputs
        const formInputs = form.querySelectorAll('input, select');
        formInputs.forEach(input => {
            input.disabled = false;
        });
        stopButton.disabled = true;
        stopButton.textContent = 'Stop Workers';
        stopButton.style.pointerEvents = '';
        form.style.opacity = '1';
        form.style.pointerEvents = 'auto';
    }
}

