const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const { authorize, getEmails } = require('./gmail-fetch');

// Load client map
const clientMap = JSON.parse(fs.readFileSync('clientMap.json', 'utf8'));

// Function to fetch emails and process them
async function fetchAndProcessEmails() {
    try {
        console.log('Authorizing Gmail access...');
        const auth = await authorize();
        console.log('Fetching emails...');
        const alerts = await getEmails(auth);
        console.log(`Found ${alerts.length} alerts to process`);
        
        if (alerts.length > 0) {
            await processAllAlerts(alerts);
        }
    } catch (error) {
        console.error('Error in fetchAndProcessEmails:', error);
    }
}

function getS3LogPath(alertData, clientMap) {
    try {
        const subject = alertData.subject || "";
        let scriptToRun = (alertData.scripts_to_run || "").toLowerCase();
        
        // Map targetresponsetime to use the same processing as 5xx
        if (scriptToRun === "targetresponsetime") {
            console.log("Detected TargetResponseTime alert, will process as 5xx");
        }
        
        const logDate = new Date(alertData.date);
        if (isNaN(logDate.getTime())) throw new Error("Invalid date format");

        const year = logDate.getUTCFullYear();
        const month = String(logDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(logDate.getUTCDate()).padStart(2, '0');
        const datePath = `${year}/${month}/${day}`;

        const subjectTokens = subject.split(/[-"]+/);
        let matchedClientKey = null;

        for (const key in clientMap) {
            const aliases = clientMap[key].aliases || [];
            if (subjectTokens.includes(key) || aliases.some(alias => subjectTokens.includes(alias))) {
                matchedClientKey = key;
                break;
            }
        }

        if (!matchedClientKey) throw new Error("Client key not matched from subject");

        const clientEntry = clientMap[matchedClientKey];
        // For targetresponsetime and 5xx, use elb path
        let baseS3Path;
        if (scriptToRun === "4xx") {
            baseS3Path = clientEntry.elb;
        } else if (scriptToRun === "targetresponsetime" || scriptToRun === "5xx") {
            baseS3Path = clientEntry.elb;
        } else {
            baseS3Path = clientEntry.alb;
        }
        
        console.log(`Using path type: ${scriptToRun} for client ${matchedClientKey}`);

        if (!baseS3Path) throw new Error(`S3 path not defined for ${scriptToRun.toUpperCase()} and client ${matchedClientKey}`);

        const fullS3Path = baseS3Path.replace(/\/+$/, '') + `/${datePath}/`;
        // Format time components
        const hours = String(logDate.getUTCHours()).padStart(2, '0');
        const minutes = String(logDate.getUTCMinutes()).padStart(2, '0');
        const seconds = String(logDate.getUTCSeconds()).padStart(2, '0');
        
        // Create folder name with client, alarm type and full datetime
        const folderName = `${matchedClientKey}-${alertData.alarm_type}-${year}${month}${day}-${hours}${minutes}${seconds}`;

        return { path: fullS3Path, clientKey: matchedClientKey, logDate, folderName, scriptToRun };

    } catch (error) {
        console.error("Error:", error.message);
        return null;
    }
}

// Function to zip output files
function zipOutputFiles(folderName) {
    return new Promise((resolve, reject) => {
        console.log(`\nAttempting to zip files for folder: ${folderName}`);
        
        let outputFiles = [];
        
        // Check files in the folder
        if (fs.existsSync(folderName)) {
            const folderFiles = fs.readdirSync(folderName)
                .filter(file => 
                    file.endsWith('-urls.txt') || 
                    file.endsWith('-rawlog.txt') || 
                    file.endsWith('-5xx-urls.txt') ||
                    file.endsWith('-5xx-rawlog.txt') ||
                    file.endsWith('-highresponse-urls.txt')
                )
                .map(file => path.join(folderName, file));
            
            console.log('Files found in folder:', folderFiles);
            outputFiles.push(...folderFiles);
        }

        // Check files in current directory
        const currentDirFiles = fs.readdirSync('.')
            .filter(file => 
                file.startsWith(folderName) && (
                    file.endsWith('-urls.txt') || 
                    file.endsWith('-rawlog.txt') || 
                    file.endsWith('-5xx-urls.txt') ||
                    file.endsWith('-5xx-rawlog.txt') ||
                    file.endsWith('-highresponse-urls.txt')
                )
            );
        
        console.log('Files found in current directory:', currentDirFiles);
        outputFiles.push(...currentDirFiles);

        if (outputFiles.length === 0) {
            console.log('No output files found to zip');
            resolve();
            return;
        }

        // Verify files exist and have content
        let hasContent = false;
        for (const file of outputFiles) {
            try {
                const stats = fs.statSync(file);
                if (stats.size > 0) {
                    hasContent = true;
                    console.log(`File ${file} has size: ${stats.size} bytes`);
                } else {
                    console.log(`File ${file} is empty`);
                }
            } catch (err) {
                console.error(`Error checking file ${file}:`, err.message);
            }
        }

        if (!hasContent) {
            console.log('No files with content found to zip');
            resolve();
            return;
        }

        const zipFileName = `${folderName}-output.zip`;
        const output = fs.createWriteStream(zipFileName);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });

        output.on('close', () => {
            console.log(`Successfully created ${zipFileName} (${archive.pointer()} bytes)`);
            
            // Delete original files and clean up directory
            try {
                // First, delete all files in the directory
                if (fs.existsSync(folderName)) {
                    const allFiles = fs.readdirSync(folderName);
                    for (const file of allFiles) {
                        const filePath = path.join(folderName, file);
                        fs.unlinkSync(filePath);
                        console.log(`Deleted file from directory: ${filePath}`);
                    }
                }

                // Delete files in current directory
                outputFiles.forEach(file => {
                    if (fs.existsSync(file)) {
                        fs.unlinkSync(file);
                        console.log(`Deleted file: ${file}`);
                    }
                });

                // Now try to delete the empty directory
                if (fs.existsSync(folderName)) {
                    fs.rmdirSync(folderName);
                    console.log(`Deleted folder: ${folderName}`);
                }
            } catch (err) {
                console.error(`Error during cleanup: ${err.message}`);
            }
            
            resolve();
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);

        console.log('Adding files to zip:');
        // Add files from both locations to the zip
        outputFiles.forEach(file => {
            try {
                const filePath = file.includes(folderName) ? file : path.join(folderName, file);
                const fileName = path.basename(file);
                
                if (fs.existsSync(filePath)) {
                    const fileContent = fs.readFileSync(filePath, 'utf8');
                    console.log(`Adding file to zip: ${filePath} (${fileContent.length} bytes)`);
                    archive.append(fileContent, { name: fileName });
                } else {
                    console.log(`File not found: ${filePath}`);
                }
            } catch (err) {
                console.error(`Error adding file ${file} to zip:`, err.message);
            }
        });

        archive.finalize();
    });
}

function downloadAndFilterLogs(s3Info, profile = 'sportz') {
    const { path: s3Path, logDate, folderName } = s3Info;

    if (!fs.existsSync(folderName)) {
        fs.mkdirSync(folderName);
    }

    const centerTime = new Date(logDate);
    const fifteenMins = 15 * 60 * 1000;
    const lowerBound = new Date(centerTime.getTime() - fifteenMins);
    const upperBound = new Date(centerTime.getTime() + fifteenMins);

    // Generate time patterns for the AWS S3 file names
    const timePatterns = [];
    let currentTime = new Date(lowerBound);
    
    // Format date components for the file pattern
    const year = centerTime.getUTCFullYear();
    const month = String(centerTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(centerTime.getUTCDate()).padStart(2, '0');
    
    // Build the grep pattern for every 5-minute interval
    while (currentTime <= upperBound) {
        const hours = String(currentTime.getUTCHours()).padStart(2, '0');
        const minutes = String(Math.floor(currentTime.getUTCMinutes() / 5) * 5).padStart(2, '0');
        timePatterns.push(`${year}${month}${day}T${hours}${minutes}`);
        currentTime.setMinutes(currentTime.getMinutes() + 5);
    }

    console.log('Generated time patterns:', timePatterns);

    // Create the grep command with all time patterns
    const grepPatterns = timePatterns.map(t => `-e "_${t}"`).join(' ');
    const downloadCommand = `aws s3 ls ${s3Path} | grep ${grepPatterns} | awk '{print $4}' | while read -r file; do aws s3 cp "${s3Path}$file" ./${folderName}/ --profile ${profile}; done`;
    
    console.log('Running command:', downloadCommand);
    try {
        execSync(downloadCommand, { stdio: 'inherit' });
    } catch (error) {
        console.log('No matching files found for the time patterns');
    }

    const logFiles = fs.readdirSync(folderName);
    for (const file of logFiles) {
        const match = file.match(/_(\d{8}T\d{4})Z_/);
        if (!match) {
            fs.unlinkSync(path.join(folderName, file));
            continue;
        }
        const timestampStr = match[1];
        const logTime = new Date(`${timestampStr.slice(0,4)}-${timestampStr.slice(4,6)}-${timestampStr.slice(6,8)}T${timestampStr.slice(9,11)}:${timestampStr.slice(11,13)}:00Z`);

        if (logTime < lowerBound || logTime > upperBound) {
            fs.unlinkSync(path.join(folderName, file));
        }
    }

    return folderName;
}

const { index } = require('./index.js');
const { index5XX } = require('./index5xx.js');

// Process alerts sequentially
async function processAlert(alertData, idx, total) {
    return new Promise(async (resolve) => {
        try {
            console.log(`\nProcessing alert ${idx + 1}/${total}`);
            console.log('Alert:', alertData.subject);
            
            // Skip if alert is marked to ignore (reply from different sender)
            if (alertData.ignore) {
                console.log('Skipping alert - marked as ignore (reply from different sender)');
                resolve(null);
                return;
            }

            const scriptType = alertData.scripts_to_run?.toLowerCase();
            const alarmType = alertData.alarm_type?.toLowerCase();
            
            if (!['4xx', '5xx', 'targetresponsetime'].includes(scriptType)) {
                console.log('Skipping alert - not a valid script type:', scriptType);
                resolve(null);
                return;
            }

            const s3Info = getS3LogPath(alertData, clientMap);
            if (s3Info) {
                const dir = downloadAndFilterLogs(s3Info);
                console.log("Processing directory:", dir);
                
                // Process the logs
                if (scriptType === '4xx') {
                    console.log('Processing 4xx errors with index.js');
                    await index(dir);
                } else {
                    console.log('Processing high response time/5xx errors with index5xx.js');
                    await index5XX(dir);
                }
                
                console.log(`Completed processing alert ${idx + 1}`);
                resolve(dir);
            } else {
                console.log('Failed to get S3 path for alert');
                resolve(null);
            }
        } catch (err) {
            console.error('Error processing alert:', err);
            resolve(null);
        }
    });
}

// Function to zip all output files from processed folders
async function createFinalZip(processedFolders) {
    return new Promise((resolve, reject) => {
        console.log('\nCreating final zip with all output files...');
        
        // Collect all txt files from all folders
        let allFiles = [];
        processedFolders.forEach(folder => {
            if (fs.existsSync(folder)) {
                const files = fs.readdirSync(folder)
                    .filter(file => 
                        file.endsWith('-urls.txt') || 
                        file.endsWith('-rawlog.txt') || 
                        file.endsWith('-5xx-urls.txt') ||
                        file.endsWith('-5xx-rawlog.txt') ||
                        file.endsWith('-highresponse-urls.txt')
                    )
                    .map(file => ({
                        path: path.join(folder, file),
                        name: `${folder}/${file}`  // Preserve folder structure in zip
                    }));
                allFiles.push(...files);
            }
        });

        if (allFiles.length === 0) {
            console.log('No output files found to zip');
            resolve();
            return;
        }

        // Create zip file with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipFileName = `alert-outputs-${timestamp}.zip`;
        const output = fs.createWriteStream(zipFileName);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`\nFinal zip created: ${zipFileName} (${archive.pointer()} bytes)`);
            
            // Clean up: delete original files and folders
            allFiles.forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    console.log(`Deleted: ${file.path}`);
                } catch (err) {
                    console.error(`Failed to delete ${file.path}:`, err.message);
                }
            });

            // Delete empty folders
            processedFolders.forEach(folder => {
                try {
                    if (fs.existsSync(folder)) {
                        fs.rmdirSync(folder);
                        console.log(`Deleted folder: ${folder}`);
                    }
                } catch (err) {
                    console.error(`Failed to delete folder ${folder}:`, err.message);
                }
            });
            
            resolve();
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);

        // Add all files to zip
        allFiles.forEach(file => {
            try {
                const content = fs.readFileSync(file.path, 'utf8');
                archive.append(content, { name: file.name });
                console.log(`Added to zip: ${file.name}`);
            } catch (err) {
                console.error(`Error adding file ${file.path} to zip:`, err.message);
            }
        });

        archive.finalize();
    });
}

// Process all alerts sequentially
async function processAllAlerts(alerts) {
    console.log(`Starting to process ${alerts.length} alerts...`);
    const processedFolders = [];  // Track all folders for final zip
    
    for (let i = 0; i < alerts.length; i++) {
        console.log(`\nProcessing alert ${i + 1} of ${alerts.length}`);
        const folder = await processAlert(alerts[i], i, alerts.length);
        if (folder) {
            processedFolders.push(folder);
        }
    }
    
    console.log('\nAll alerts have been processed');
    
    // Create single zip file with all outputs
    await createFinalZip(processedFolders);
}

// Start fetching and processing
fetchAndProcessEmails();
