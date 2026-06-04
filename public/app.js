// State
let uploadQueue = [];
let uploadInProgress = false;
let uploadStartTime = null;
let batchTotalBytes = 0;
let batchCompletedBytes = 0;
let currentFileProgress = 0;
let nextEntryId = 0;

const CHUNK_SIZE_DESKTOP = 2 * 1024 * 1024;
const CHUNK_SIZE_IOS = 1 * 1024 * 1024;
const CHUNK_THRESHOLD_DESKTOP = 100 * 1024 * 1024;
const CHUNK_THRESHOLD_IOS = 1024 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 3;
const CHUNK_RETRY_DELAYS = [1000, 2000, 4000];
const CHUNK_XHR_TIMEOUT = 5 * 60 * 1000;
const MAX_UPLOAD_TIMEOUT = 60 * 60 * 1000;
const MIN_UPLOAD_SPEED = 256 * 1024;
const FETCH_TIMEOUT = 30 * 1000;
const PROGRESS_UI_INTERVAL = 200;
const BLOB_SNAPSHOT_LIMIT = 50 * 1024 * 1024;

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

function isIOSSafari() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function getChunkSize() {
    return isIOSSafari() ? CHUNK_SIZE_IOS : CHUNK_SIZE_DESKTOP;
}

function getChunkThreshold() {
    return isIOSSafari() ? CHUNK_THRESHOLD_IOS : CHUNK_THRESHOLD_DESKTOP;
}

function getUploadTimeout(fileSize) {
    const estimated = (fileSize / MIN_UPLOAD_SPEED) * 1000;
    return Math.min(Math.max(estimated, CHUNK_XHR_TIMEOUT), MAX_UPLOAD_TIMEOUT);
}

function createQueueEntry(file) {
    const entry = {
        id: nextEntryId++,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        file,
        status: 'pending',
        uploadId: generateUploadId(),
        bytesUploaded: 0
    };

    if (file.size <= BLOB_SNAPSHOT_LIMIT) {
        entry.blob = file.slice(0, file.size, entry.type);
    }

    return entry;
}

function getUploadSource(entry) {
    if (entry.file && entry.file.size === entry.size) {
        return entry.file;
    }
    if (!entry.blob) {
        entry.blob = entry.file.slice(0, entry.size, entry.type);
    }
    return entry.blob;
}

class SequentialBlobReader {
    constructor(source) {
        this.source = source;
        this.reader = null;
        this.workBlob = null;
        this.pending = new Uint8Array(0);
        this.position = 0;
    }

    async seek(offset) {
        await this.close();
        this.position = offset;
    }

    async read(length) {
        if (!this.reader) {
            this.workBlob = this.source.slice(this.position);
            this.reader = this.workBlob.stream().getReader();
        }

        const parts = [];
        let collected = 0;

        if (this.pending.length > 0) {
            const take = Math.min(this.pending.length, length);
            parts.push(this.pending.slice(0, take));
            this.pending = this.pending.slice(take);
            collected += take;
        }

        while (collected < length) {
            const { done, value } = await this.reader.read();
            if (done) {
                break;
            }

            const needed = length - collected;
            if (value.byteLength <= needed) {
                parts.push(value);
                collected += value.byteLength;
            } else {
                parts.push(value.slice(0, needed));
                this.pending = value.slice(needed);
                collected += needed;
            }
        }

        this.position += collected;

        if (collected === 0) {
            return new ArrayBuffer(0);
        }

        if (parts.length === 1) {
            const part = parts[0];
            return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
        }

        const combined = new Uint8Array(collected);
        let offset = 0;
        for (const part of parts) {
            combined.set(part, offset);
            offset += part.byteLength;
        }
        return combined.buffer;
    }

    async close() {
        if (this.reader) {
            await this.reader.cancel().catch(() => {});
            this.reader = null;
        }
        this.workBlob = null;
        this.pending = new Uint8Array(0);
    }
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
    if (files.length === 0) return;

    const MAX_FILES = 1000;
    const currentCount = uploadQueue.length;
    const newFiles = files.filter(file =>
        !uploadQueue.find(entry => entry.name === file.name && entry.size === file.size)
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
                    <div class="file-item-name">${escapeHtml(entry.name)}</div>
                    <span class="file-item-status file-item-status--${entry.status}">${STATUS_LABELS[entry.status]}</span>
                </div>
                <div class="file-item-size">${formatFileSize(entry.size)}</div>
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

    batchTotalBytes = entriesToProcess.reduce((sum, entry) => sum + entry.size, 0);

    let uploadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
        const serverFiles = await fetchServerFiles();
        const serverIndex = buildServerFileIndex(serverFiles);

        for (const entry of entriesToProcess) {
            if (isAlreadyUploaded({ name: entry.name, size: entry.size }, serverIndex)) {
                entry.status = 'skipped';
                skippedCount++;
                batchCompletedBytes += entry.size;
                updateBatchProgress(0);
                updateFileList();
                continue;
            }

            entry.status = 'uploading';
            currentFileProgress = 0;
            updateFileList();
            updateProgressUI(0, true);

            const result = await uploadFileEntry(entry, (loaded) => {
                currentFileProgress = entry.size > 0 ? (loaded / entry.size) * 100 : 0;
                updateProgressUI(loaded);
            });

            if (result.success) {
                entry.status = 'done';
                uploadedCount++;
                batchCompletedBytes += entry.size;
                serverIndex.set(`${result.filename}\0${entry.size}`, { name: result.filename, size: entry.size });
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
        fileInput.value = '';
        return;
    }

    uploadInProgress = false;
    progressContainer.style.display = 'none';
    updateButtons();
    fileInput.value = '';

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
    if (entry.size <= getChunkThreshold()) {
        return uploadFileSmallWithRetry(entry, onProgress);
    }
    return uploadFileChunked(entry, onProgress);
}

async function uploadFileSmallWithRetry(entry, onProgress) {
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        const result = await uploadFileSmall(entry, onProgress);
        if (result.success) {
            return result;
        }
        if (attempt < MAX_CHUNK_RETRIES - 1) {
            await delay(CHUNK_RETRY_DELAYS[attempt] || 4000);
        }
    }
    return { success: false };
}

function uploadFileSmall(entry, onProgress) {
    return new Promise((resolve) => {
        onProgress(0);

        const formData = new FormData();
        formData.append('files', getUploadSource(entry), entry.name);

        const xhr = new XMLHttpRequest();
        xhr.timeout = getUploadTimeout(entry.size);

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
                        filename: uploaded ? uploaded.name : sanitizeFilename(entry.name)
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
            originalName: entry.name,
            totalSize: entry.size,
            chunkSize: getChunkSize()
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
    const reader = new SequentialBlobReader(getUploadSource(entry));
    const chunkSize = getChunkSize();

    try {
        const session = await initChunkUpload(entry);
        let bytesUploaded = session.offset;
        let resyncCount = 0;
        entry.bytesUploaded = bytesUploaded;
        onProgress(bytesUploaded);

        if (bytesUploaded > 0) {
            await reader.seek(bytesUploaded);
        }

        while (bytesUploaded < entry.size) {
            const chunkStart = bytesUploaded;
            const chunkLength = Math.min(chunkSize, entry.size - bytesUploaded);
            const buffer = await reader.read(chunkLength);

            if (buffer.byteLength === 0) {
                throw new Error('Failed to read file data');
            }

            try {
                await sendChunkWithRetry(entry, chunkStart, buffer, buffer.byteLength, (loaded) => {
                    entry.bytesUploaded = chunkStart + loaded;
                    onProgress(entry.bytesUploaded);
                }, getUploadTimeout(buffer.byteLength));

                bytesUploaded = await verifyUploadOffset(entry, chunkStart + buffer.byteLength);
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
                    await reader.seek(bytesUploaded);
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
    } finally {
        await reader.close();
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

async function sendChunkWithRetry(entry, chunkStart, buffer, chunkLength, onChunkProgress, timeout) {
    let currentOffset = chunkStart;
    let remainingBuffer = buffer;
    let networkAttempts = 0;
    let syncAttempts = 0;

    while (networkAttempts < MAX_CHUNK_RETRIES) {
        try {
            if (remainingBuffer.byteLength === 0) {
                return;
            }

            await sendChunk(entry.uploadId, currentOffset, remainingBuffer, onChunkProgress, timeout);
            return;
        } catch (error) {
            if (error.status === 409) {
                syncAttempts++;
                if (syncAttempts > 10) {
                    throw new Error('Upload could not sync with server');
                }

                const session = await initChunkUpload(entry);
                const serverOffset = session.offset;

                if (serverOffset >= chunkStart + chunkLength) {
                    return;
                }

                if (serverOffset < chunkStart) {
                    const resyncError = new Error('Upload resync required');
                    resyncError.resyncOffset = serverOffset;
                    throw resyncError;
                }

                currentOffset = serverOffset;
                const skipBytes = serverOffset - chunkStart;
                remainingBuffer = buffer.slice(skipBytes);
                onChunkProgress(skipBytes);
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

function sendChunk(uploadId, offset, buffer, onChunkProgress, timeout = CHUNK_XHR_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = timeout;

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
        xhr.send(buffer);
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
