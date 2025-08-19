require('dotenv').config({ path: './.env' });
console.log('ID?', !!process.env.SPOTIFY_CLIENT_ID, 'SECRET?', !!process.env.SPOTIFY_CLIENT_SECRET);
