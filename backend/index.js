require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

// Track mapping stub
app.post('/map/song', (req, res) => {
  // TODO: call Spotify & Apple Music catalog APIs
  res.json({ mappedUrl: 'https://example.com/placeholder' });
});

// Album mapping stub
app.post('/map/album', (req, res) => {
  // TODO: map each track and return an array of URLs
  res.json({ mappedUrls: ['https://example.com/track1', 'https://example.com/track2'] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Mapping service listening on port' + PORT));
