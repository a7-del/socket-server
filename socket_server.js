// socket_server.js
const express = require('express');
const fs = require('fs');
const https = require('https');
const app = express();
require('dotenv').config();

const { Server } = require('socket.io');
const { Pool } = require('pg');

// Load SSL certs (adjust path based on where certbot put them)
const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/fuel.injibara.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/fuel.injibara.com/fullchain.pem')
};

// Use HTTPS server
const httpsServer = https.createServer(options, app);

// Initialize Socket.IO on HTTPS
const io = new Server(httpsServer, {
  cors: {
    origin: [
      "https://fuel.injibara.com",
      "http://fuel.injibara.com",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"]
  }
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STATION_INTERVAL_MS = 1000;
const activeStations = new Set();
const driverSocketMap = new Map();
const socketDriverMap = new Map();

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('join_monitor', async ({ station_id, driver_id }) => {
    socket.join(`station_${station_id}`);
    activeStations.add(station_id);

    if (driver_id) {
      driverSocketMap.set(driver_id, socket.id);
      socketDriverMap.set(socket.id, driver_id);
      console.log(`🧾 Driver ${driver_id} registered on station ${station_id}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    const driverId = socketDriverMap.get(socket.id);
    if (driverId) {
      driverSocketMap.delete(driverId);
      socketDriverMap.delete(socket.id);
      console.log(`🧹 Cleaned up driver ${driverId}`);
    }
  });
});

setInterval(async () => {
  try {
    for (const stationId of activeStations) {
      const { rows } = await pool.query(
        `SELECT queue_number, status FROM queue WHERE station_id = $1 ORDER BY id ASC`,
        [stationId]
      );

      const waiting = rows.filter(r => r.status === 'waiting');
      const totalInQueue = waiting.length;
      const currentServing = rows.find(r => r.status === 'serving')?.queue_number || '-';
      const estimatedWait = Math.round(totalInQueue * 2);

      io.to(`station_${stationId}`).emit(`queue_update_${stationId}`, {
        queue_count: totalInQueue,
        current_number: currentServing,
        estimated_wait: estimatedWait
      });
    }
  } catch (err) {
    console.error('❗ Interval error:', err);
  }
});

app.get('/notify', (req, res) => {
  const driverId = parseInt(req.query.id);
  if (!driverId) return res.status(400).send('❌ Missing driver ID');

  const socketId = driverSocketMap.get(driverId);
  if (socketId) {
    io.to(socketId).emit('driver_third_notice', { driverId });
    return res.send(`✅ Notification sent to driver ID ${driverId}`);
  }

  res.status(404).send(`❌ Driver ID ${driverId} not connected`);
});

// ✅ Use port 3000 or 443
const PORT = process.env.PORT || 3000;
httpsServer.listen(PORT, () => {
  console.log(`✅ Socket.IO server running securely at https://fuel.injibara.com:${PORT}`);
});
