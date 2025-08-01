const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load JSON files
const alertData = JSON.parse(fs.readFileSync('alert.json', 'utf8'));
const clientMap = JSON.parse(fs.readFileSync('clientMap.json', 'utf8'));

function getS3LogPath(alertData, clientMap) {
    try {
        const subject = alertData.subject || "";
        const scriptToRun = (alertData.script_to_run || "").toLowerCase();
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
        const baseS3Path = scriptToRun === "4xx" ? clientEntry.elb : clientEntry.alb;

        if (!baseS3Path) throw new Error(`S3 path not defined for ${scriptToRun.toUpperCase()} and client ${matchedClientKey}`);

        const fullS3Path = baseS3Path.replace(/\/+$/, '') + `/${datePath}/`;
        const folderName = `${matchedClientKey}-${year}-${month}-${day}`;

        return { path: fullS3Path, clientKey: matchedClientKey, logDate, folderName, scriptToRun };

    } catch (error) {
        console.error("Error:", error.message);
        return null;
    }
}

function downloadAndFilterLogs(s3Info, profile = 'sportz') {
    const { path: s3Path, logDate, folderName } = s3Info;

    if (!fs.existsSync(folderName)) {
        fs.mkdirSync(folderName);
    }

    const downloadCommand = `aws s3 cp ${s3Path} ./${folderName} --recursive --profile ${profile}`;
    console.log(`Running: ${downloadCommand}`);
    execSync(downloadCommand, { stdio: 'inherit' });

    const centerTime = new Date(logDate);
    const fifteenMins = 15 * 60 * 1000;
    const lowerBound = new Date(centerTime.getTime() - fifteenMins);
    const upperBound = new Date(centerTime.getTime() + fifteenMins);

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

const s3Info = getS3LogPath(alertData, clientMap);
if (s3Info) {
    const dir = downloadAndFilterLogs(s3Info);
    if (s3Info.scriptToRun === '4xx') {
        index(dir);
    } else {
        index5XX(dir);
    }
}
