const express = require('express');
const cors = require('cors');
const config = require('./config');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Faruk\'s SmartBiz backend চলছে ✅');
});

app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);

app.listen(config.port, () => {
  console.log(`✅ Server চলছে: http://localhost:${config.port}`);
});
