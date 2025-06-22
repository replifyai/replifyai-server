require('dotenv').config();

// No need to set default config values since we're using environment variables
// The configService will handle defaults

const app = require('../src/index');

// Export the express app for Vercel
module.exports = app;
