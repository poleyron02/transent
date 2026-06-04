# Transent - Local File Sharing Web App

A local web application similar to ShareIt that allows you to transfer files between your phone and computer over your local network. Choose where to save files at startup, then access the web interface from any device on your network.

## Features

- 📤 **File Upload**: Upload multiple files from your phone or computer
- 📥 **File Download**: Download uploaded files to any device
- 📋 **File Listing**: View all uploaded files with metadata (size, upload date)
- 🗑️ **File Management**: Delete files directly from the web interface
- 📱 **Mobile-Friendly**: Responsive design optimized for mobile devices
- 🔄 **Progress Indicators**: Real-time upload progress tracking
- 🌐 **Local Network Access**: Access from any device on your local network

## Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)

## Installation

1. Clone or download this repository
2. Install dependencies:

```bash
npm install
```

## Usage

### Starting the Server

Run the server with:

```bash
npm start
```

When you start the server, you'll be prompted to enter the directory where uploaded files should be saved. You can also specify the directory and port via command-line arguments:

```bash
# Specify directory
node server.js --dir "C:\Users\YourName\Downloads\TransentFiles"

# Specify directory and port
node server.js --dir "C:\Users\YourName\Downloads\TransentFiles" --port 3000

# Short form
node server.js -d "./uploads" -p 8080
```

### Accessing the Web Interface

Once the server starts, you'll see output like this:

```
============================================================
🚀 Transent File Sharing Server Started
============================================================
📁 Save Directory: C:\Users\YourName\Downloads\TransentFiles
🌐 Local Access:    http://localhost:3000
📱 Phone Access:    http://192.168.1.100:3000
============================================================

Open the URL above on your phone to upload files!
```

- **Local Access**: Open `http://localhost:3000` on the same computer
- **Phone Access**: Open `http://192.168.1.100:3000` (or the IP shown) on any device connected to the same Wi-Fi network

### Uploading Files

1. Open the web interface on your phone or computer
2. Tap/click the upload area or drag and drop files
3. Select one or multiple files
4. Click "Upload Files"
5. Wait for the upload to complete (progress bar will show status)

### Downloading Files

1. View the list of uploaded files
2. Click the "Download" button next to any file
3. The file will download to your device

### Deleting Files

1. Click the "Delete" button next to any file
2. Confirm the deletion
3. The file will be removed from the server

## Configuration

### Command-Line Arguments

- `--dir` or `-d`: Specify the directory to save uploaded files
- `--port` or `-p`: Specify the port number (default: 3000)

### File Limits

- Maximum file size: 10GB per file
- Maximum files per upload: 50 files
- No limit on total number of files

## Security Notes

⚠️ **Important**: This application is designed for use on trusted local networks only. It does not include authentication or encryption. Do not expose this server to the internet without proper security measures.

- Files are saved to the directory you specify at startup
- Filenames are sanitized to prevent directory traversal attacks
- Only files within the save directory can be accessed

## Troubleshooting

### Can't access from phone

1. Make sure your phone and computer are on the same Wi-Fi network
2. Check that your firewall isn't blocking the port
3. Verify the IP address shown in the server output matches your computer's local IP
4. Try accessing from the computer first using `localhost` to verify the server is running

### Port already in use

If port 3000 is already in use, specify a different port:

```bash
node server.js --port 8080
```

### Permission errors

Make sure you have write permissions to the directory you specify. On Windows, you may need to run the command prompt as Administrator.

### Files not appearing

- Click the "Refresh" button to reload the file list
- Check that files were actually uploaded (check the save directory)
- Verify the server has read permissions for the save directory

## Project Structure

```
transent/
├── server.js              # Main Express server
├── package.json           # Dependencies and scripts
├── config.js              # Configuration utilities
├── utils/
│   ├── fileManager.js     # File operations
│   └── networkUtils.js    # IP detection
├── public/
│   ├── index.html         # Main UI
│   ├── styles.css         # Styling
│   └── app.js             # Frontend logic
└── README.md              # This file
```

## License

MIT

## Contributing

Feel free to submit issues and enhancement requests!
