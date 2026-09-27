// Adds the iOS Firebase file only once it exists, so Android builds work before iOS is set up.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const plist = path.join(__dirname, 'GoogleService-Info.plist');
  if (fs.existsSync(plist)) config.ios = { ...config.ios, googleServicesFile: './GoogleService-Info.plist' };
  return config;
};
