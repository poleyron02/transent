const fs = require('fs').promises;
const path = require('path');

/**
 * Sanitize filename to prevent directory traversal and invalid characters
 */
function sanitizeFilename(filename) {
  // Remove path separators and dangerous characters
  let sanitized = filename
    .replace(/[\/\\]/g, '_')  // Replace slashes
    .replace(/[<>:"|?*]/g, '_')  // Replace invalid Windows characters
    .replace(/\.\./g, '_')  // Replace parent directory references
    .trim();
  
  // Ensure filename is not empty
  if (!sanitized || sanitized === '.') {
    sanitized = 'unnamed_file';
  }
  
  // Limit filename length
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    const name = sanitized.slice(0, 255 - ext.length);
    sanitized = name + ext;
  }
  
  return sanitized;
}

/**
 * Ensure directory exists, create if it doesn't
 */
async function ensureDirectoryExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (error) {
    // Directory doesn't exist, create it
    await fs.mkdir(dirPath, { recursive: true });
  }
}

/**
 * Get file info for listing
 */
async function getFileInfo(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return {
      name: path.basename(filePath),
      size: stats.size,
      modified: stats.mtime,
      isFile: stats.isFile()
    };
  } catch (error) {
    return null;
  }
}

/**
 * List all files in directory
 */
async function listFiles(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    const fileInfos = await Promise.all(
      files.map(file => getFileInfo(path.join(dirPath, file)))
    );
    
    // Filter out nulls and directories, sort by modified date (newest first)
    return fileInfos
      .filter(info => info && info.isFile)
      .sort((a, b) => b.modified - a.modified);
  } catch (error) {
    return [];
  }
}

/**
 * Handle duplicate filenames by appending a number
 */
async function getUniqueFilename(dirPath, filename) {
  const sanitized = sanitizeFilename(filename);
  const basePath = path.join(dirPath, sanitized);
  
  // Check if file exists
  try {
    await fs.access(basePath);
    
    // File exists, append number
    const ext = path.extname(sanitized);
    const name = path.basename(sanitized, ext);
    let counter = 1;
    let newPath;
    
    do {
      const newName = `${name}_${counter}${ext}`;
      newPath = path.join(dirPath, newName);
      try {
        await fs.access(newPath);
        counter++;
      } catch {
        return path.basename(newPath);
      }
    } while (true);
  } catch {
    // File doesn't exist, use original
    return sanitized;
  }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

module.exports = {
  sanitizeFilename,
  ensureDirectoryExists,
  getFileInfo,
  listFiles,
  getUniqueFilename,
  formatFileSize
};
