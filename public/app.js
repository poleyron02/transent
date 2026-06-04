// State
let uploadQueue = [];
let uploadInProgress = false;
let uploadStartTime = null;
let batchTotalBytes = 0;
let batchCompletedBytes = 0;
let currentFileProgress = 0;
let nextEntryId = 0;

const CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_THRESHOLD = CHUNK_SIZE;
const MAX_CHUNK_RETRIES = 3;
const CHUNK_RETRY_DELAYS = [1000, 2000, 4000];
const CHUNK_XHR_TIMEOUT = 5 * 60 * 1000;

const STATUS_LABELS = {
    pending: 'Pending',
    uploading: 'Uploading',
    done: 'Done',
    failed: 'Failed',
    skipped: 'Skipped'
};

// DOM Elements
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const uploadBtn = document.getElementById('uploadBtn');
const retryBtn = document.getElementById('retryBtn');
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
    uploadArea.addEventListener('click', () => {
        if (!uploadInProgress) {
            fileInput.click();
        }
    });

    fileInput.addEventListener('change', handleFileSelect);
    uploadArea.addEventListener('dragover', handleDragOver);
    uploadArea.addEventListener('dragleave', handleDragLeave);
    uploadArea.addEventListener('drop', handleDrop);
    uploadBtn.addEventListener('click', () => startUpload({ retryOnly: false }));
    retryBtn.addEventListener('click', () => startUpload({ retryOnly: true }));
}

function createQueueEntry(file) {
    return {
        id: nextEntryId++,
        file,
        status: 'pending',
        uploadId: crypto.randomUUID(),
        bytesUploaded: 0
    };
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
    const currentCount = uploadQueue.length;
    const newFiles = files.filter(file =>
        !uploadQueue.find(entry => entry.file.name === file.name && entry.file.size === file.size)
    );

    if (currentCount + newFiles.length > MAX_FILES) {
        const allowed = MAX_FILES - currentCount;
        if (allowed > 0) {
            showToast(`Only ${allowed} more file(s) can be added. Maximum is ${MAX_FILES} files.`, 'error');
            newFiles.slice(0, allowed).forEach(file => uploadQueue.push(createQueueEntry(file)));
        } else {
            showToast(`Maximum of ${MAX_FILES} files reached. Please remove some files first.`, 'error');
        }
    } else {
        newFiles.forEach(file => uploadQueue.push(createQueueEntry(file)));
    }

    updateFileList();
    updateButtons();
}

function removeFile(index) {
    const entry = uploadQueue[index];
    if (uploadInProgress || (entry && entry.status !== 'pending')) return;

    uploadQueue.splice(index, 1);
    updateFileList();
    updateButtons();
    fileInput.value = '';
}

function updateFileList() {
    if (uploadQueue.length === 0) {
        fileList.innerHTML = '';
        return;
    }

    fileList.innerHTML = uploadQueue.map((entry, index) => {
        const canRemove = !uploadInProgress && entry.status === 'pending';
        const progressBar = entry.status === 'uploading'
            ? `<div class="file-item-progress"><div class="file-item-progress-fill" style="width: ${Math.round(currentFileProgress)}%"></div></div>`
            : '';

        return `
        <div class="file-item file-item--${entry.status}">
            <div class="file-item-info">
                <div class="file-item-header">
                    <div class="file-item-name">${escapeHtml(entry.file.name)}</div>
                    <span class="file-item-status file-item-status--${entry.status}">${STATUS_LABELS[entry.status]}</span>
                </div>
                <div class="file-item-size">${formatFileSize(entry.file.size)}</div>
                ${progressBar}
            </div>
            ${canRemove ? `<button class="file-item-remove" onclick="removeFile(${index})">Remove</button>` : ''}
        </div>
    `;
    }).join('');
}

function updateButtons() {
    const hasPending = uploadQueue.some(entry => entry.status === 'pending');
    const hasFailed = uploadQueue.some(entry => entry.status === 'failed');

    uploadBtn.disabled = !hasPending || uploadInProgress;
    uploadBtn.textContent = uploadInProgress ? 'Uploading...' : 'Upload Files';

    retryBtn.style.display = hasFailed && !uploadInProgress ? 'block' : 'none';
    retryBtn.disabled = uploadInProgress;
}

function sanitizeFilename(filename) {
    let sanitized = filename
        .replace(/[\/\\]/g, '_')
        .replace(/[<>:"|?*]/g, '_')
        .replace(/\.\./g, '_')
        .trim();

    if (!sanitized || sanitized === '.') {
        sanitized = 'unnamed_file';
    }

    if (sanitized.length > 255) {
        const lastDot = sanitized.lastIndexOf('.');
        const ext = lastDot > 0 ? sanitized.slice(lastDot) : '';
        sanitized = sanitized.slice(0, 255 - ext.length) + ext;
    }

    return sanitized;
}

function getPossibleServerNames(originalName) {
    const sanitized = sanitizeFilename(originalName);
    const lastDot = sanitized.lastIndexOf('.');
    const ext = lastDot > 0 ? sanitized.slice(lastDot) : '';
    const base = lastDot > 0 ? sanitized.slice(0, lastDot) : sanitized;

    const names = [sanitized];
    for (let i = 1; i <= 1000; i++) {
        names.push(`${base}_${i}${ext}`);
    }
    return names;
}

function buildServerFileIndex(serverFiles) {
    const index = new Map();
    for (const serverFile of serverFiles) {
        const key = `${serverFile.name}\0${serverFile.size}`;
        index.set(key, serverFile);
    }
    return index;
}

function isAlreadyUploaded(file, serverIndex) {
    const possibleNames = getPossibleServerNames(file.name);
    for (const name of possibleNames) {
        const key = `${name}\0${file.size}`;
        if (serverIndex.has(key)) {
            return true;
        }
    }
    return false;
}

async function fetchServerFiles() {
    const response = await fetch('/api/files');
    if (!response.ok) {
        throw new Error('Failed to fetch server file list');
    }
    return response.json();
}

function resetProgressUI() {
    progressContainer.style.display = 'block';
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    progressSpeed.textContent = '0 B/s';
    progressTime.textContent = 'Calculating...';
    batchCompletedBytes = 0;
    currentFileProgress = 0;
    uploadStartTime = Date.now();
}

function updateBatchProgress(currentLoaded = 0) {
    const totalLoaded = batchCompletedBytes + currentLoaded;
    const percent = batchTotalBytes > 0 ? (totalLoaded / batchTotalBytes) * 100 : 0;

    progressFill.style.width = percent + '%';
    progressPercent.textContent = Math.round(percent) + '%';

    const elapsed = (Date.now() - uploadStartTime) / 1000;
    if (elapsed >= 0.5 && totalLoaded > 0) {
        const avgSpeed = totalLoaded / elapsed;
        progressSpeed.textContent = formatSpeed(avgSpeed);
        const remaining = batchTotalBytes - totalLoaded;
        progressTime.textContent = remaining > 0 ? formatTime(remaining / avgSpeed) : '0s';
    } else if (totalLoaded === 0) {
        progressTime.textContent = 'Calculating...';
    }
}

function getEntriesForRun(retryOnly) {
    if (retryOnly) {
        return uploadQueue.filter(entry => entry.status === 'failed');
    }
    return uploadQueue.filter(entry => entry.status === 'pending');
}

async function startUpload({ retryOnly }) {
    if (uploadInProgress) return;

    const entriesToProcess = getEntriesForRun(retryOnly);
    if (entriesToProcess.length === 0) {
        if (retryOnly) {
            showToast('No failed files to retry.', 'error');
        }
        return;
    }

    uploadInProgress = true;
    updateButtons();
    resetProgressUI();

    batchTotalBytes = entriesToProcess.reduce((sum, entry) => sum + entry.file.size, 0);

    let uploadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
        const serverFiles = await fetchServerFiles();
        const serverIndex = buildServerFileIndex(serverFiles);

        for (const entry of entriesToProcess) {
            if (isAlreadyUploaded(entry.file, serverIndex)) {
                entry.status = 'skipped';
                skippedCount++;
                batchCompletedBytes += entry.file.size;
                updateBatchProgress(0);
                updateFileList();
                continue;
            }

            entry.status = 'uploading';
            currentFileProgress = 0;
            updateFileList();

            const result = await uploadFileEntry(entry, (loaded) => {
                currentFileProgress = entry.file.size > 0 ? (loaded / entry.file.size) * 100 : 0;
                updateBatchProgress(loaded);
                updateFileList();
            });

            if (result.success) {
                entry.status = 'done';
                uploadedCount++;
                batchCompletedBytes += entry.file.size;
                serverIndex.set(`${result.filename}\0${entry.file.size}`, { name: result.filename, size: entry.file.size });
            } else {
                entry.status = 'failed';
                failedCount++;
            }

            currentFileProgress = 0;
            updateBatchProgress(0);
            updateFileList();
        }
    } catch (error) {
        showToast(error.message || 'Upload failed', 'error');
        uploadInProgress = false;
        progressContainer.style.display = 'none';
        updateButtons();
        updateFileList();
        return;
    }

    uploadInProgress = false;
    progressContainer.style.display = 'none';
    updateButtons();

    const allFinished = uploadQueue.every(entry =>
        entry.status === 'done' || entry.status === 'skipped'
    );

    if (allFinished) {
        uploadQueue = [];
        updateFileList();
    }

    showUploadSummary(uploadedCount, skippedCount, failedCount);
}

function uploadFileEntry(entry, onProgress) {
    if (entry.file.size <= CHUNK_THRESHOLD) {
        return uploadFileSmall(entry, onProgress);
    }
    return uploadFileChunked(entry, onProgress);
}

function uploadFileSmall(entry, onProgress) {
    return new Promise((resolve) => {
        const formData = new FormData();
        formData.append('files', entry.file);

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                onProgress(e.loaded);
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                try {
                    const response = JSON.parse(xhr.responseText);
                    const uploaded = response.files && response.files[0];
                    resolve({
                        success: true,
                        filename: uploaded ? uploaded.name : sanitizeFilename(entry.file.name)
                    });
                } catch {
                    resolve({ success: false });
                }
            } else {
                resolve({ success: false });
            }
        });

        xhr.addEventListener('error', () => resolve({ success: false }));
        xhr.open('POST', '/upload');
        xhr.send(formData);
    });
}

async function initChunkUpload(entry) {
    const response = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadId: entry.uploadId,
            originalName: entry.file.name,
            totalSize: entry.file.size,
            chunkSize: CHUNK_SIZE
        })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to initialize upload');
    }

    return response.json();
}

async function completeChunkUpload(uploadId) {
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        try {
            const response = await fetch('/api/upload/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId })
            });

            if (response.ok) {
                return response.json();
            }

            const error = await response.json().catch(() => ({}));
            if (response.status >= 400 && response.status < 500) {
                throw new Error(error.error || 'Failed to complete upload');
            }
        } catch (error) {
            if (attempt === MAX_CHUNK_RETRIES - 1) {
                throw error;
            }
        }

        await delay(CHUNK_RETRY_DELAYS[attempt] || 4000);
    }

    throw new Error('Failed to complete upload');
}

async function uploadFileChunked(entry, onProgress) {
    try {
        const session = await initChunkUpload(entry);
        let bytesUploaded = session.offset;
        entry.bytesUploaded = bytesUploaded;
        onProgress(bytesUploaded);

        while (bytesUploaded < entry.file.size) {
            const chunkStart = bytesUploaded;
            const chunkEnd = Math.min(bytesUploaded + CHUNK_SIZE, entry.file.size);
            const chunk = entry.file.slice(chunkStart, chunkEnd);

            const chunkLength = await sendChunkWithRetry(entry, chunkStart, chunk, (loaded) => {
                entry.bytesUploaded = chunkStart + loaded;
                onProgress(entry.bytesUploaded);
            });

            bytesUploaded = chunkStart + chunkLength;
            entry.bytesUploaded = bytesUploaded;
            onProgress(bytesUploaded);
        }

        const result = await completeChunkUpload(entry.uploadId);
        return {
            success: true,
            filename: result.filename
        };
    } catch {
        return { success: false };
    }
}

async function sendChunkWithRetry(entry, offset, chunk, onChunkProgress) {
    let currentOffset = offset;
    let remainingChunk = chunk;

    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        try {
            await sendChunk(entry.uploadId, currentOffset, remainingChunk, onChunkProgress);
            return chunk.size;
        } catch (error) {
            if (error.status === 409) {
                const session = await initChunkUpload(entry);
                currentOffset = session.offset;

                if (currentOffset >= offset + chunk.size) {
                    return chunk.size;
                }

                if (currentOffset > offset) {
                    remainingChunk = chunk.slice(currentOffset - offset);
                    onChunkProgress(currentOffset - offset);
                } else {
                    remainingChunk = chunk;
                    onChunkProgress(0);
                }

                continue;
            }

            if (error.status >= 400 && error.status < 500) {
                throw error;
            }

            if (attempt < MAX_CHUNK_RETRIES - 1) {
                await delay(CHUNK_RETRY_DELAYS[attempt] || 4000);
            }
        }
    }

    throw new Error('Chunk upload failed after retries');
}

function sendChunk(uploadId, offset, chunk, onChunkProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = CHUNK_XHR_TIMEOUT;

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                onChunkProgress(e.loaded);
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                resolve();
                return;
            }

            let body = {};
            try {
                body = JSON.parse(xhr.responseText);
            } catch {
                body = {};
            }

            const error = new Error(body.error || 'Chunk upload failed');
            error.status = xhr.status;
            if (body.currentOffset !== undefined) {
                error.currentOffset = body.currentOffset;
            }
            reject(error);
        });

        xhr.addEventListener('error', () => {
            const error = new Error('Network error');
            error.status = 0;
            reject(error);
        });

        xhr.addEventListener('timeout', () => {
            const error = new Error('Chunk upload timed out');
            error.status = 0;
            reject(error);
        });

        xhr.open('PUT', '/api/upload/chunk');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Upload-Id', uploadId);
        xhr.setRequestHeader('X-Chunk-Offset', String(offset));
        xhr.send(chunk);
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function showUploadSummary(uploaded, skipped, failed) {
    if (uploaded === 0 && skipped === 0 && failed === 0) {
        return;
    }

    const parts = [];
    if (uploaded > 0) parts.push(`${uploaded} uploaded`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (failed > 0) parts.push(`${failed} failed`);

    const message = parts.join(', ');
    if (failed > 0) {
        showToast(message, 'error');
    } else if (uploaded === 0 && skipped > 0) {
        showToast('All files already uploaded', 'success');
    } else {
        showToast(message, 'success');
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

window.removeFile = removeFile;
