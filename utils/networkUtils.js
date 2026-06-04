const os = require('os');

/**
 * Get the local IP address for network access
 * Returns the first non-internal IPv4 address
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  
  return 'localhost';
}

/**
 * Display server access information
 */
function displayServerInfo(port, saveDir) {
  const ip = getLocalIP();
  const localUrl = `http://localhost:${port}`;
  const networkUrl = `http://${ip}:${port}`;
  
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Transent File Sharing Server Started');
  console.log('='.repeat(60));
  console.log(`📁 Save Directory: ${saveDir}`);
  console.log(`🌐 Local Access:    ${localUrl}`);
  console.log(`📱 Phone Access:    ${networkUrl}`);
  console.log('='.repeat(60));
  console.log('\nOpen the URL above on your phone to upload files!\n');
}

module.exports = {
  getLocalIP,
  displayServerInfo
};
