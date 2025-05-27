// socket_server.js (RENDER-COMPATIBLE)
const express = require('express');
const http = require('http'); // Use HTTP not HTTPS on Render
const { Server } = require('socket.io');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app); // No certs needed on Render

// Use process.env.PORT (required on Render)
const PORT = process.env.PORT || 3000;

// CORS Setup for client origins
const io = new Server(server, {
  cors: {
    origin: [
      "https://fuel.injibara.com",
      "http://fuel.injibara.com"
    ],
    methods: ["GET", "POST"]
  }
});

// PostgreSQL Connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Queuing logic
const STATION_INTERVAL_MS = 1000;
const activeStations = new Set();
const driverSocketMap = new Map();
const socketDriverMap = new Map();

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('join_monitor', ({ station_id, driver_id }) => {
    socket.join(`station_${station_id}`);
    activeStations.add(station_id);

    if (driver_id) {
      driverSocketMap.set(driver_id, socket.id);
      socketDriverMap.set(socket.id, driver_id);
      console.log(`🧾 Driver ${driver_id} joined station ${station_id}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    const driverId = socketDriverMap.get(socket.id);
    if (driverId) {
      driverSocketMap.delete(driverId);
      socketDriverMap.delete(socket.id);
      console.log(`🧹 Cleaned driver ${driverId}`);
    }
  });
});

// Queue status broadcaster
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

// Notify a specific driver
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
// Add this route for testing root
app.get('/', (req, res) => {
  res.send('✅ Fuel Queue Socket Server is running!');
});
// Start the server
server.listen(PORT, () => {
  console.log(`✅ Socket.IO server running on port ${PORT}`);
});
