// socket_server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
require('dotenv').config();

const { Server } = require('socket.io');
const io = new Server(http, {
  cors: {
    origin: "fuel.injibara.com",
    methods: ["GET", "POST"]
  }
});

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const STATION_INTERVAL_MS = 3000;
const activeStations = new Set();
const driverSocketMap = new Map(); // New: driver_id => socket.id
const socketDriverMap = new Map(); // New: socket.id => driver_id

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // ✅ Join station + register driver
  socket.on('join_monitor', async ({ station_id, driver_id }) => {
    socket.join(`station_${station_id}`);
    activeStations.add(station_id);

    if (driver_id) {
      driverSocketMap.set(driver_id, socket.id);
      socketDriverMap.set(socket.id, driver_id);
      console.log(`🧾 Driver ${driver_id} registered on station ${station_id}`);
    }
  });

  // ✅ Clean up on disconnect
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

// ✅ Efficient update loop for all active stations
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
}, STATION_INTERVAL_MS);

// ✅ Targeted PHP Notification Endpoint
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

// ✅ Start server
const PORT = 3000;
http.listen(PORT, () => {
  console.log(`✅ Socket.IO server running at http://localhost:${PORT}`);
});
