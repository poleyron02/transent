// State
let uploadQueue = [];
let uploadInProgress = false;
let uploadStartTime = null;
let batchTotalBytes = 0;
let batchCompletedBytes = 0;
let currentFileProgress = 0;
let nextEntryId = 0;

const CHUNK_SIZE = 2 * 1024 * 1024;
const CHUNK_THRESHOLD = 8 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;
const CHUNK_RETRY_DELAYS = [1000, 2000, 4000];
const CHUNK_XHR_TIMEOUT = 5 * 60 * 1000;
const FETCH_TIMEOUT = 30 * 1000;
const PROGRESS_UI_INTERVAL = 200;

let lastProgressUiUpdate = 0;

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
    if (retryBtn) {
        retryBtn.addEventListener('click', () => startUpload({ retryOnly: true }));
    }
}

function generateUploadId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createQueueEntry(file) {
    return {
        id: nextEntryId++,
        file,
        status: 'pending',
        uploadId: generateUploadId(),
        bytesUploaded: 0
    };
}

// File Selection
function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    addFiles(files);
    fileInput.value = '';
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
    if (files.length === 0) return;

    const MAX_FILES = 1000;
    const currentCount = uploadQueue.length;
    const newFiles = files.filter(file =>
        !uploadQueue.find(entry => entry.file.name === file.name && entry.file.size === file.size)
    );

    if (newFiles.length === 0) {
        showToast('Selected file(s) are already in the queue.', 'error');
        return;
    }

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

    if (retryBtn) {
        retryBtn.style.display = hasFailed && !uploadInProgress ? 'block' : 'none';
        retryBtn.disabled = uploadInProgress;
    }
}

function updateFileProgressBar() {
    const fill = fileList.querySelector('.file-item--uploading .file-item-progress-fill');
    if (fill) {
        fill.style.width = Math.round(currentFileProgress) + '%';
    }
}

function updateProgressUI(currentLoaded = 0, force = false) {
    const now = Date.now();
    if (!force && now - lastProgressUiUpdate < PROGRESS_UI_INTERVAL) {
        return;
    }
    lastProgressUiUpdate = now;
    updateBatchProgress(currentLoaded);
    updateFileProgressBar();
}

function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
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
    const response = await fetchWithTimeout('/api/files', {}, FETCH_TIMEOUT);
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
    lastProgressUiUpdate = 0;

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
                updateProgressUI(loaded);
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
            updateProgressUI(0, true);
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
        xhr.timeout = CHUNK_XHR_TIMEOUT;

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
        xhr.addEventListener('timeout', () => resolve({ success: false }));
        xhr.open('POST', '/upload');
        xhr.send(formData);
    });
}

async function initChunkUpload(entry) {
    const response = await fetchWithTimeout('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uploadId: entry.uploadId,
            originalName: entry.file.name,
            totalSize: entry.file.size,
            chunkSize: CHUNK_SIZE
        })
    }, FETCH_TIMEOUT);

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to initialize upload');
    }

    return response.json();
}

async function completeChunkUpload(uploadId) {
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        try {
            const response = await fetchWithTimeout('/api/upload/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId })
            }, FETCH_TIMEOUT);

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
        let resyncCount = 0;
        entry.bytesUploaded = bytesUploaded;
        onProgress(bytesUploaded);

        while (bytesUploaded < entry.file.size) {
            const chunkStart = bytesUploaded;
            const chunkEnd = Math.min(bytesUploaded + CHUNK_SIZE, entry.file.size);
            const chunk = entry.file.slice(chunkStart, chunkEnd);

            try {
                await sendChunkWithRetry(entry, chunkStart, chunk, (loaded) => {
                    entry.bytesUploaded = chunkStart + loaded;
                    onProgress(entry.bytesUploaded);
                });

                bytesUploaded = await verifyUploadOffset(entry, chunkStart + chunk.size);
            } catch (error) {
                if (error.resyncOffset !== undefined) {
                    if (error.resyncOffset < bytesUploaded) {
                        resyncCount++;
                        if (resyncCount > 5) {
                            throw new Error('Upload could not recover after repeated sync failures');
                        }
                    }
                    bytesUploaded = error.resyncOffset;
                    entry.bytesUploaded = bytesUploaded;
                    onProgress(bytesUploaded);
                    continue;
                }
                throw error;
            }

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

async function verifyUploadOffset(entry, expectedOffset) {
    const session = await initChunkUpload(entry);
    if (session.offset >= expectedOffset) {
        return session.offset;
    }

    const resyncError = new Error('Upload resync required');
    resyncError.resyncOffset = session.offset;
    throw resyncError;
}

async function sendChunkWithRetry(entry, chunkStart, chunk, onChunkProgress) {
    let currentOffset = chunkStart;
    let remainingChunk = chunk;
    let networkAttempts = 0;
    let syncAttempts = 0;

    while (networkAttempts < MAX_CHUNK_RETRIES) {
        try {
            if (remainingChunk.size === 0) {
                return;
            }

            await sendChunk(entry.uploadId, currentOffset, remainingChunk, onChunkProgress);
            return;
        } catch (error) {
            if (error.status === 409) {
                syncAttempts++;
                if (syncAttempts > 10) {
                    throw new Error('Upload could not sync with server');
                }

                const session = await initChunkUpload(entry);
                const serverOffset = session.offset;

                if (serverOffset >= chunkStart + chunk.size) {
                    return;
                }

                if (serverOffset < chunkStart) {
                    const resyncError = new Error('Upload resync required');
                    resyncError.resyncOffset = serverOffset;
                    throw resyncError;
                }

                currentOffset = serverOffset;
                remainingChunk = chunk.slice(serverOffset - chunkStart);
                onChunkProgress(serverOffset - chunkStart);
                continue;
            }

            if (error.status >= 400 && error.status < 500) {
                throw error;
            }

            networkAttempts++;
            if (networkAttempts < MAX_CHUNK_RETRIES) {
                await delay(CHUNK_RETRY_DELAYS[networkAttempts - 1] || 4000);
            }
        }
    }

    throw new Error('Chunk upload failed after retries');
}

async function sendChunk(uploadId, offset, chunk, onChunkProgress) {
    const buffer = await chunk.arrayBuffer();
    onChunkProgress(0);

    const response = await fetchWithTimeout('/api/upload/chunk', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream',
            'X-Upload-Id': uploadId,
            'X-Chunk-Offset': String(offset)
        },
        body: buffer
    }, CHUNK_XHR_TIMEOUT);

    onChunkProgress(buffer.byteLength);

    if (response.ok) {
        return;
    }

    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || 'Chunk upload failed');
    error.status = response.status;
    if (body.currentOffset !== undefined) {
        error.currentOffset = body.currentOffset;
    }
    throw error;
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
