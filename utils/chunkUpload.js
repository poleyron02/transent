const fs = require('fs').promises;
const path = require('path');
const { ensureDirectoryExists, getUniqueFilename, sanitizeFilename } = require('./fileManager');

const UPLOADS_DIR = '.transent-uploads';
const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_CHUNK_SIZE = DEFAULT_CHUNK_SIZE + 1024;

function getUploadsDir(saveDir) {
  return path.join(saveDir, UPLOADS_DIR);
}

function getPartPath(uploadsDir, uploadId) {
  return path.join(uploadsDir, `${uploadId}.part`);
}

function getMetaPath(uploadsDir, uploadId) {
  return path.join(uploadsDir, `${uploadId}.meta.json`);
}

function isValidUploadId(uploadId) {
  return typeof uploadId === 'string' && /^[0-9a-f-]{36}$/i.test(uploadId);
}

async function readMeta(uploadsDir, uploadId) {
  const metaPath = getMetaPath(uploadsDir, uploadId);
  const data = await fs.readFile(metaPath, 'utf8');
  return JSON.parse(data);
}

async function writeMeta(uploadsDir, meta) {
  const metaPath = getMetaPath(uploadsDir, meta.uploadId);
  await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');
}

async function getPartSize(partPath) {
  try {
    const stats = await fs.stat(partPath);
    return stats.size;
  } catch {
    return 0;
  }
}

async function initUpload(saveDir, { uploadId, originalName, totalSize, chunkSize }) {
  if (!isValidUploadId(uploadId)) {
    throw Object.assign(new Error('Invalid upload ID'), { status: 400 });
  }

  if (!originalName || !Number.isFinite(totalSize) || totalSize < 0) {
    throw Object.assign(new Error('Invalid upload parameters'), { status: 400 });
  }

  const normalizedTotalSize = Math.floor(totalSize);

  const normalizedChunkSize = chunkSize || DEFAULT_CHUNK_SIZE;
  if (normalizedChunkSize > MAX_CHUNK_SIZE) {
    throw Object.assign(new Error('Chunk size too large'), { status: 400 });
  }

  const uploadsDir = getUploadsDir(saveDir);
  await ensureDirectoryExists(uploadsDir);

  const partPath = getPartPath(uploadsDir, uploadId);
  const metaPath = getMetaPath(uploadsDir, uploadId);

  let meta;
  try {
    meta = await readMeta(uploadsDir, uploadId);
  } catch {
    meta = null;
  }

  if (meta) {
    if (meta.totalSize !== normalizedTotalSize || meta.originalName !== originalName) {
      throw Object.assign(new Error('Upload session mismatch'), { status: 409 });
    }

    const offset = await getPartSize(partPath);
    return {
      uploadId,
      offset,
      targetFilename: meta.targetFilename,
      totalSize: meta.totalSize
    };
  }

  const existingPartSize = await getPartSize(partPath);
  if (existingPartSize > 0) {
    throw Object.assign(new Error('Upload session corrupted'), { status: 409 });
  }

  const sanitizedName = sanitizeFilename(originalName);
  const targetFilename = await getUniqueFilename(saveDir, sanitizedName);

  meta = {
    uploadId,
    originalName,
    targetFilename,
    totalSize: normalizedTotalSize,
    chunkSize: normalizedChunkSize,
    createdAt: new Date().toISOString()
  };

  await fs.writeFile(partPath, Buffer.alloc(0));
  await writeMeta(uploadsDir, meta);

  return {
    uploadId,
    offset: 0,
    targetFilename,
    totalSize: normalizedTotalSize
  };
}

async function writeChunk(saveDir, uploadId, offset, buffer) {
  if (!isValidUploadId(uploadId)) {
    throw Object.assign(new Error('Invalid upload ID'), { status: 400 });
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('Empty chunk'), { status: 400 });
  }

  if (buffer.length > MAX_CHUNK_SIZE) {
    throw Object.assign(new Error('Chunk too large'), { status: 400 });
  }

  const uploadsDir = getUploadsDir(saveDir);
  let meta;

  try {
    meta = await readMeta(uploadsDir, uploadId);
  } catch {
    throw Object.assign(new Error('Upload session not found'), { status: 404 });
  }

  const partPath = getPartPath(uploadsDir, uploadId);
  const currentSize = await getPartSize(partPath);

  if (offset !== currentSize) {
    throw Object.assign(new Error('Chunk offset mismatch'), { status: 409, currentOffset: currentSize });
  }

  if (currentSize + buffer.length > meta.totalSize) {
    throw Object.assign(new Error('Chunk exceeds total file size'), { status: 400 });
  }

  const fileHandle = await fs.open(partPath, 'r+');
  try {
    await fileHandle.write(buffer, 0, buffer.length, offset);
    if (typeof fileHandle.sync === 'function') {
      await fileHandle.sync();
    }
  } finally {
    await fileHandle.close();
  }

  const newOffset = currentSize + buffer.length;

  return { offset: newOffset };
}

async function completeUpload(saveDir, uploadId) {
  if (!isValidUploadId(uploadId)) {
    throw Object.assign(new Error('Invalid upload ID'), { status: 400 });
  }

  const uploadsDir = getUploadsDir(saveDir);
  let meta;

  try {
    meta = await readMeta(uploadsDir, uploadId);
  } catch {
    throw Object.assign(new Error('Upload session not found'), { status: 404 });
  }

  const partPath = getPartPath(uploadsDir, uploadId);
  const finalPath = path.join(saveDir, meta.targetFilename);

  const partSize = await getPartSize(partPath);

  if (partSize !== meta.totalSize) {
    throw Object.assign(new Error(`Incomplete upload: ${partSize}/${meta.totalSize} bytes`), { status: 400 });
  }

  try {
    const finalStats = await fs.stat(finalPath);
    if (finalStats.size === meta.totalSize) {
      await Promise.allSettled([
        fs.unlink(partPath),
        fs.unlink(getMetaPath(uploadsDir, uploadId))
      ]);
      return {
        success: true,
        filename: meta.targetFilename,
        size: meta.totalSize
      };
    }
  } catch {
    // Final file doesn't exist yet
  }

  try {
    await fs.access(finalPath);
    await fs.unlink(partPath);
    await fs.unlink(getMetaPath(uploadsDir, uploadId));
    return {
      success: true,
      filename: meta.targetFilename,
      size: meta.totalSize
    };
  } catch {
    await fs.rename(partPath, finalPath);
    await fs.unlink(getMetaPath(uploadsDir, uploadId));
    return {
      success: true,
      filename: meta.targetFilename,
      size: meta.totalSize
    };
  }
}

async function abortUpload(saveDir, uploadId) {
  if (!isValidUploadId(uploadId)) {
    throw Object.assign(new Error('Invalid upload ID'), { status: 400 });
  }

  const uploadsDir = getUploadsDir(saveDir);
  const partPath = getPartPath(uploadsDir, uploadId);
  const metaPath = getMetaPath(uploadsDir, uploadId);

  await Promise.allSettled([
    fs.unlink(partPath),
    fs.unlink(metaPath)
  ]);

  return { success: true };
}

async function cleanupStaleUploads(saveDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  const uploadsDir = getUploadsDir(saveDir);

  try {
    await fs.access(uploadsDir);
  } catch {
    return { removed: 0 };
  }

  const files = await fs.readdir(uploadsDir);
  const metaFiles = files.filter(file => file.endsWith('.meta.json'));
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const metaFile of metaFiles) {
    const uploadId = metaFile.replace('.meta.json', '');
    const metaPath = path.join(uploadsDir, metaFile);

    try {
      const data = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(data);
      const createdAt = new Date(meta.createdAt).getTime();

      if (createdAt < cutoff) {
        await abortUpload(saveDir, uploadId);
        removed++;
      }
    } catch {
      await abortUpload(saveDir, uploadId);
      removed++;
    }
  }

  return { removed };
}

module.exports = {
  UPLOADS_DIR,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  initUpload,
  writeChunk,
  completeUpload,
  abortUpload,
  cleanupStaleUploads
};
