// State
let selectedFiles = [];
let uploadInProgress = false;
let uploadStartTime = null;
let lastLoaded = 0;
let lastTime = null;

// DOM Elements
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const uploadBtn = document.getElementById('uploadBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const progressSpeed = document.getElementById('progressSpeed');
const progressTime = document.getElementById('progressTime');
const toast = document.getElementById('toast');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
});

// Event Listeners
function setupEventListeners() {
    // Upload area click
    uploadArea.addEventListener('click', () => {
        if (!uploadInProgress) {
            fileInput.click();
        }
    });

    // File input change
    fileInput.addEventListener('change', handleFileSelect);

    // Drag and drop
    uploadArea.addEventListener('dragover', handleDragOver);
    uploadArea.addEventListener('dragleave', handleDragLeave);
    uploadArea.addEventListener('drop', handleDrop);

    // Upload button
    uploadBtn.addEventListener('click', handleUpload);
}

// File Selection
function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    addFiles(files);
}

function handleDragOver(e) {
    e.preventDefault();
    uploadArea.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    
    if (uploadInProgress) return;
    
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
}

function addFiles(files) {
    const MAX_FILES = 1000;
    const currentCount = selectedFiles.length;
    const newFiles = files.filter(file => 
        !selectedFiles.find(f => f.name === file.name && f.size === file.size)
    );
    
    if (currentCount + newFiles.length > MAX_FILES) {
        const allowed = MAX_FILES - currentCount;
        if (allowed > 0) {
            showToast(`Only ${allowed} more file(s) can be added. Maximum is ${MAX_FILES} files.`, 'error');
            newFiles.slice(0, allowed).forEach(file => selectedFiles.push(file));
        } else {
            showToast(`Maximum of ${MAX_FILES} files reached. Please remove some files first.`, 'error');
        }
    } else {
        newFiles.forEach(file => selectedFiles.push(file));
    }
    
    updateFileList();
    updateUploadButton();
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileList();
    updateUploadButton();
    fileInput.value = ''; // Reset input
}

function updateFileList() {
    if (selectedFiles.length === 0) {
        fileList.innerHTML = '';
        return;
    }

    fileList.innerHTML = selectedFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-item-info">
                <div class="file-item-name">${escapeHtml(file.name)}</div>
                <div class="file-item-size">${formatFileSize(file.size)}</div>
            </div>
            <button class="file-item-remove" onclick="removeFile(${index})">Remove</button>
        </div>
    `).join('');
}

function updateUploadButton() {
    uploadBtn.disabled = selectedFiles.length === 0 || uploadInProgress;
}

// Upload
async function handleUpload() {
    if (selectedFiles.length === 0 || uploadInProgress) return;
    
    const MAX_FILES = 1000;
    if (selectedFiles.length > MAX_FILES) {
        showToast(`Too many files. Maximum is ${MAX_FILES} files per upload.`, 'error');
        return;
    }

    uploadInProgress = true;
    updateUploadButton();
    progressContainer.style.display = 'block';
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    progressSpeed.textContent = '0 KB/s';
    progressTime.textContent = 'Calculating...';
    
    // Reset timing variables
    uploadStartTime = Date.now();
    lastLoaded = 0;
    lastTime = uploadStartTime;

    const formData = new FormData();
    selectedFiles.forEach(file => {
        formData.append('files', file);
    });

    try {
        const xhr = new XMLHttpRequest();

        // Upload progress
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = (e.loaded / e.total) * 100;
                progressFill.style.width = percentComplete + '%';
                progressPercent.textContent = Math.round(percentComplete) + '%';
                
                // Calculate speed and ETA
                const now = Date.now();
                const timeDiff = (now - lastTime) / 1000; // seconds
                const loadedDiff = e.loaded - lastLoaded; // bytes
                
                if (timeDiff > 0) {
                    const speed = loadedDiff / timeDiff; // bytes per second
                    progressSpeed.textContent = formatSpeed(speed);
                    
                    // Calculate ETA
                    const remaining = e.total - e.loaded;
                    if (speed > 0) {
                        const etaSeconds = remaining / speed;
                        progressTime.textContent = formatTime(etaSeconds);
                    } else {
                        progressTime.textContent = '--';
                    }
                }
                
                lastLoaded = e.loaded;
                lastTime = now;
            }
        });

        // Handle response
        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                const response = JSON.parse(xhr.responseText);
                showToast(`Successfully uploaded ${response.files.length} file(s)`, 'success');
                selectedFiles = [];
                updateFileList();
                updateUploadButton();
            } else {
                const error = JSON.parse(xhr.responseText);
                showToast(error.error || 'Upload failed', 'error');
            }
            progressContainer.style.display = 'none';
            uploadInProgress = false;
            updateUploadButton();
        });

        xhr.addEventListener('error', () => {
            showToast('Upload failed. Please try again.', 'error');
            progressContainer.style.display = 'none';
            uploadInProgress = false;
            updateUploadButton();
        });

        xhr.open('POST', '/upload');
        xhr.send(formData);
    } catch (error) {
        showToast('Upload failed: ' + error.message, 'error');
        progressContainer.style.display = 'none';
        uploadInProgress = false;
        updateUploadButton();
    }
}

// Format speed
function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return Math.round(bytesPerSecond / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Format time
function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) {
        return '--';
    }
    
    if (seconds < 60) {
        return Math.ceil(seconds) + 's';
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.ceil(seconds % 60);
        return minutes + 'm ' + secs + 's';
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return hours + 'h ' + minutes + 'm';
    }
}

// Toast Notification
function showToast(message, type = '') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Utility Functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Make removeFile available globally for onclick handlers
window.removeFile = removeFile;
