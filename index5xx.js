const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const rl = require('readline');

function index5XX(dir) {
  return new Promise((resolve) => {
    let stats = { req: 0, errors: 0, highResponseTime: 0 };
    let fname = dir;
  let files = fs.readdirSync(dir);
  let count = 0;

  function readFile() {
    console.log(stats);
    let file = files[count];

    console.log('Reading File --> ' + count + ' --> ' + file);
    count++;

    let errors = [];
    let errorsURLs = [];
    let highResponseTimeUrls = [];

    let ext = path.extname(file);
    let input =
      ext === '.gz'
        ? fs.createReadStream(path.join(dir, file)).pipe(zlib.createGunzip())
        : fs.createReadStream(path.join(dir, file));

    let lineReader = rl.createInterface({ input });

    lineReader.on('line', ogline => {
      if (ogline.charAt(0) === '#') return;
      stats.req++;

      let line = ogline.split(' ');
      let url = line[13];
      let statusCode = line[8];
      let reqTime = line[1];
      let timeTaken = +line[5] + +line[6] + +line[7];

      if (timeTaken > 2) {
        stats.highResponseTime++;
        highResponseTimeUrls.push({ reqTime, url, timeTaken, statusCode });
      }

      if (statusCode?.charAt(0) === '5') {
        stats.errors++;
        errors.push(ogline);
        errorsURLs.push(`${reqTime} : ${url} ${timeTaken}s ${statusCode}`);
      }
    });

    lineReader.on('close', () => {
      let filesCreated = false;
      
      if (errors.length > 0) {
        // Create files in the directory
        const rawlogPath = path.join(fname, fname + '-5xx-rawlog.txt');
        const urlsPath = path.join(fname, fname + '-5xx-urls.txt');
        fs.writeFileSync(rawlogPath, errors.join('\n'));
        fs.writeFileSync(urlsPath, errorsURLs.join('\n'));
        console.log(`Created 5xx files with ${errors.length} errors in ${fname}`);
        filesCreated = true;
      } else {
        console.log(`No 5xx errors found for ${fname}`);
      }

      if (highResponseTimeUrls.length > 0) {
        highResponseTimeUrls.sort((a, b) => {
          const timeDiff = b.timeTaken - a.timeTaken;
          return timeDiff !== 0 ? timeDiff : b.reqTime.localeCompare(a.reqTime);
        });

        const logLines = highResponseTimeUrls.map(log => `${log.reqTime} : ${log.url} ${log.timeTaken}s ${log.statusCode}`);
        const highResponsePath = path.join(fname, fname + '-highresponse-urls.txt');
        fs.writeFileSync(highResponsePath, logLines.join('\n'));
        console.log(`Created high response time file with ${highResponseTimeUrls.length} entries in ${fname}`);
        filesCreated = true;
      } else {
        console.log(`No high response time entries found for ${fname}`);
      }

      if (!filesCreated) {
        console.log(`No issues found for ${fname}, no files created`);
      }

      if (files[count]) {
        readFile();
      } else {
        console.log('Done');
        console.log(stats);
        resolve(stats);
      }
    });
  }

  readFile();
  });
}

module.exports = { index5XX };
