const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { getSaveDirectory } = require('./config');
const { displayServerInfo } = require('./utils/networkUtils');
const { ensureDirectoryExists, getUniqueFilename, listFiles, formatFileSize } = require('./utils/fileManager');
const {
  initUpload,
  writeChunk,
  completeUpload,
  abortUpload,
  cleanupStaleUploads,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE
} = require('./utils/chunkUpload');

const app = express();
let SAVE_DIRECTORY = null;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize multer storage configuration
function getMulterInstance() {
    if (!SAVE_DIRECTORY) {
        throw new Error('SAVE_DIRECTORY not set');
    }

    const storage = multer.diskStorage({
        destination: async (req, file, cb) => {
            await ensureDirectoryExists(SAVE_DIRECTORY);
            cb(null, SAVE_DIRECTORY);
        },
        filename: async (req, file, cb) => {
            const uniqueName = await getUniqueFilename(SAVE_DIRECTORY, file.originalname);
            cb(null, uniqueName);
        }
    });

    return multer({
        storage: storage,
        limits: {
            fileSize: 10 * 1024 * 1024 * 1024 // 10GB limit
        }
    });
}

// API Routes

// Get list of uploaded files
app.get('/api/files', async (req, res) => {
    try {
        const files = await listFiles(SAVE_DIRECTORY);
        const filesWithFormattedSize = files.map(file => ({
            name: file.name,
            size: file.size,
            sizeFormatted: formatFileSize(file.size),
            modified: file.modified.toISOString()
        }));
        res.json(filesWithFormattedSize);
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Upload files (small-file fallback)
app.post('/upload', async (req, res) => {
    if (!SAVE_DIRECTORY) {
        return res.status(503).json({ error: 'Server not fully initialized. Please try again in a moment.' });
    }

    try {
        const multerInstance = getMulterInstance();
        const upload = multerInstance.array('files', 1000); // Allow up to 1000 files

        upload(req, res, (err) => {
            if (err) {
                console.error('Upload error:', err);
                if (err instanceof multer.MulterError) {
                    if (err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(400).json({ error: 'File too large. Maximum size is 10GB.' });
                    }
                    if (err.code === 'LIMIT_FILE_COUNT') {
                        return res.status(400).json({ error: 'Too many files. Maximum is 1000 files per upload.' });
                    }
                    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                        // This can happen when more files are sent than the limit allows
                        // Check if the field name is 'files' - if so, it's likely a file count issue
                        if (err.field === 'files') {
                            return res.status(400).json({ error: 'Too many files. Maximum is 1000 files per upload. Please upload files in smaller batches.' });
                        }
                        return res.status(400).json({ error: `Unexpected field: ${err.field}. Expected field name: 'files'` });
                    }
                }
                return res.status(500).json({ error: 'Upload failed: ' + err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files uploaded' });
            }

            const uploadedFiles = req.files.map(file => ({
                name: file.filename,
                originalName: file.originalname,
                size: file.size
            }));

            res.json({
                success: true,
                message: `Successfully uploaded ${uploadedFiles.length} file(s)`,
                files: uploadedFiles
            });
        });
    } catch (error) {
        console.error('Upload setup error:', error);
        res.status(500).json({ error: 'Upload setup failed: ' + error.message });
    }
});

function handleChunkError(res, error) {
  const status = error.status || 500;
  const body = { error: error.message || 'Chunk upload failed' };
  if (error.currentOffset !== undefined) {
    body.currentOffset = error.currentOffset;
  }
  return res.status(status).json(body);
}

// Chunked upload: initialize session
app.post('/api/upload/init', async (req, res) => {
  if (!SAVE_DIRECTORY) {
    return res.status(503).json({ error: 'Server not fully initialized. Please try again in a moment.' });
  }

  try {
    const { uploadId, originalName, totalSize, chunkSize } = req.body || {};
    const result = await initUpload(SAVE_DIRECTORY, {
      uploadId,
      originalName,
      totalSize: Number(totalSize),
      chunkSize: chunkSize || DEFAULT_CHUNK_SIZE
    });
    res.json(result);
  } catch (error) {
    handleChunkError(res, error);
  }
});

// Chunked upload: write chunk
app.put('/api/upload/chunk', express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_SIZE }), async (req, res) => {
  if (!SAVE_DIRECTORY) {
    return res.status(503).json({ error: 'Server not fully initialized. Please try again in a moment.' });
  }

  req.setTimeout(10 * 60 * 1000);

  try {
    const uploadId = req.headers['x-upload-id'];
    const offset = parseInt(req.headers['x-chunk-offset'], 10);

    if (!uploadId || Number.isNaN(offset)) {
      return res.status(400).json({ error: 'Missing X-Upload-Id or X-Chunk-Offset header' });
    }

    const result = await writeChunk(SAVE_DIRECTORY, uploadId, offset, req.body);
    res.json(result);
  } catch (error) {
    handleChunkError(res, error);
  }
});

// Chunked upload: finalize
app.post('/api/upload/complete', async (req, res) => {
  if (!SAVE_DIRECTORY) {
    return res.status(503).json({ error: 'Server not fully initialized. Please try again in a moment.' });
  }

  try {
    const { uploadId } = req.body || {};
    const result = await completeUpload(SAVE_DIRECTORY, uploadId);
    res.json(result);
  } catch (error) {
    handleChunkError(res, error);
  }
});

// Chunked upload: cancel and remove partial
app.delete('/api/upload/:uploadId', async (req, res) => {
  if (!SAVE_DIRECTORY) {
    return res.status(503).json({ error: 'Server not fully initialized. Please try again in a moment.' });
  }

  try {
    const result = await abortUpload(SAVE_DIRECTORY, req.params.uploadId);
    res.json(result);
  } catch (error) {
    handleChunkError(res, error);
  }
});

// Download file
app.get('/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(SAVE_DIRECTORY, filename);

        // Security check: ensure file is within save directory
        const resolvedPath = path.resolve(filePath);
        const resolvedDir = path.resolve(SAVE_DIRECTORY);

        if (!resolvedPath.startsWith(resolvedDir)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: 'File not found' });
        }

        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Download failed' });
                }
            }
        });
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Download failed' });
    }
});

// Delete file
app.delete('/api/files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join(SAVE_DIRECTORY, filename);

        // Security check
        const resolvedPath = path.resolve(filePath);
        const resolvedDir = path.resolve(SAVE_DIRECTORY);

        if (!resolvedPath.startsWith(resolvedDir)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await fs.unlink(filePath);
        res.json({ success: true, message: 'File deleted' });
    } catch (error) {
        console.error('Delete error:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else {
            res.status(500).json({ error: 'Delete failed' });
        }
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        saveDirectory: SAVE_DIRECTORY
    });
});

// Start server
async function startServer() {
    try {
        const config = await getSaveDirectory();
        SAVE_DIRECTORY = config.dir;
        const port = config.port || 3000;

        // Ensure directory exists
        await ensureDirectoryExists(SAVE_DIRECTORY);
        await cleanupStaleUploads(SAVE_DIRECTORY);

        app.listen(port, () => {
            displayServerInfo(port, SAVE_DIRECTORY);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nShutting down server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\nShutting down server...');
    process.exit(0);
});

startServer();
