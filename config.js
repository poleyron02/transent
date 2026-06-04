const readline = require('readline');
const path = require('path');
const fs = require('fs').promises;

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 3000,
    dir: null
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      config.port = parseInt(args[i + 1], 10);
    } else if (args[i] === '--dir' && args[i + 1]) {
      config.dir = args[i + 1];
    } else if (args[i] === '-p' && args[i + 1]) {
      config.port = parseInt(args[i + 1], 10);
    } else if (args[i] === '-d' && args[i + 1]) {
      config.dir = args[i + 1];
    }
  }
  
  return config;
}

/**
 * Prompt user for directory selection
 */
function promptForDirectory() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('Enter the directory path to save uploaded files (or press Enter for current directory): ', async (answer) => {
      rl.close();
      
      const dirPath = answer.trim() || process.cwd();
      const resolvedPath = path.resolve(dirPath);
      
      try {
        // Verify directory exists or can be created
        await fs.access(resolvedPath).catch(() => {
          throw new Error('Directory does not exist');
        });
        resolve(resolvedPath);
      } catch (error) {
        console.error(`Error: Directory "${resolvedPath}" is not accessible.`);
        console.log('Please ensure the directory exists and you have write permissions.\n');
        // Retry
        resolve(await promptForDirectory());
      }
    });
  });
}

/**
 * Get save directory from args or prompt
 */
async function getSaveDirectory() {
  const args = parseArgs();
  
  if (args.dir) {
    const resolvedPath = path.resolve(args.dir);
    try {
      await fs.access(resolvedPath);
      return { dir: resolvedPath, port: args.port };
    } catch (error) {
      console.error(`Error: Directory "${resolvedPath}" is not accessible.`);
      console.log('Falling back to interactive selection...\n');
    }
  }
  
  const dir = await promptForDirectory();
  return { dir, port: args.port };
}

module.exports = {
  parseArgs,
  promptForDirectory,
  getSaveDirectory
};
