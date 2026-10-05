'use strict';
// Template files of a fresh Creator project (templates/). The browser bundle replaces this module with an
// embedded copy of the same files (scripts/bundle.js), so nothing here may depend on reading the disk elsewhere.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'templates');

module.exports = { readTemplate: (name) => fs.readFileSync(path.join(DIR, name), 'utf8') };
