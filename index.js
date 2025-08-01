const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const rl = require('readline');

function index(dir) {
  let stats = { req: 0, errors: 0 };
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

    let ext = path.extname(file);
    let input;
    if (ext === '.gz') {
      input = fs.createReadStream(path.join(dir, file)).pipe(zlib.createGunzip());
    } else {
      input = fs.createReadStream(path.join(dir, file));
    }

    let lineReader = rl.createInterface({ input });

    lineReader.on('line', ogline => {
      if (ogline.charAt(0) === '#') return;
      stats['req']++;

      let line = ogline.split(' ');
      let url = line[13];
      let statusCode = line[8];
      let timeTaken = +line[5] + +line[6] + +line[7];

      if (statusCode?.charAt(0) === '4') {
        stats['errors']++;
        errors.push(ogline);
        errorsURLs.push(url);
      }
    });

    lineReader.on('close', () => {
      if (errors.length > 0) {
        fs.appendFileSync(fname + '-rawlog.txt', '\n' + errors.join('\n'));
        fs.appendFileSync(fname + '-urls.txt', '\n' + errorsURLs.join('\n'));
      }

      if (files[count]) {
        readFile();
      } else {
        console.log('Done');
        console.log(stats);
      }
    });
  }

  readFile();
}

module.exports = { index };
