// Enhanced socket_server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);

const { Server } = require('socket.io');
const io = new Server(http, {
  cors: {
    origin: ["https://fuel.injibara.com", "http://fuel.injibara.com"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Constants
const STATION_INTERVAL_MS = 3000;
const NOTIFICATION_POSITIONS = {
  THIRD: 3,
  FIRST: 1
};

// State management
const activeStations = new Set();
const driverSocketMap = new Map(); // driver_id => socket.id
const socketDriverMap = new Map(); // socket.id => driver_id
const driverNotificationState = new Map(); // driver_id => { lastThirdNotice: Date }

// Helper functions
async function getQueueData(stationId) {
  const { rows } = await pool.query(
    `SELECT id, queue_number, status, driver_id 
     FROM queue 
     WHERE station_id = $1 
     ORDER BY 
       CASE status 
         WHEN 'serving' THEN 1 
         WHEN 'waiting' THEN 2 
         ELSE 3 
       END, 
       id ASC`,
    [stationId]
  );
  return rows;
}

function calculateWaitTime(queueLength) {
  // 2 minutes per vehicle + 5 minutes base time
  return Math.max(5, queueLength * 2);
}

function shouldSendThirdNotice(driverId) {
  const now = new Date();
  const lastNotice = driverNotificationState.get(driverId)?.lastThirdNotice;
  
  if (!lastNotice) return true;
  return (now - lastNotice) > 600000; // 10 minutes cooldown
}

// Socket.IO Events
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

// Queue Processing Engine
setInterval(async () => {
  try {
    for (const stationId of activeStations) {
      const queueData = await getQueueData(stationId);
      const waitingQueue = queueData.filter(r => r.status === 'waiting');
      const servingDriver = queueData.find(r => r.status === 'serving');

      // Broadcast general queue update
      io.to(`station_${stationId}`).emit(`queue_update_${stationId}`, {
        queue_count: waitingQueue.length,
        current_number: servingDriver?.queue_number || '-',
        estimated_wait: calculateWaitTime(waitingQueue.length)
      });

      // Process notifications
      waitingQueue.forEach((driver, index) => {
        const position = index + 1;
        const driverId = driver.driver_id;
        const socketId = driverSocketMap.get(driverId);

        if (!socketId) return;

        // Send third place notice
        if (position === NOTIFICATION_POSITIONS.THIRD && shouldSendThirdNotice(driverId)) {
          io.to(socketId).emit('driver_third_notice', { 
            driverId,
            position,
            stationId
          });
          driverNotificationState.set(driverId, { lastThirdNotice: new Date() });
          console.log(`🔔 Sent third place notice to driver ${driverId}`);
        }

        // Send "your turn" notice
        if (position === NOTIFICATION_POSITIONS.FIRST) {
          io.to(socketId).emit('your_turn_notice', {
            driverId,
            stationId,
            queueNumber: driver.queue_number
          });
          console.log(`🔔 Sent your turn notice to driver ${driverId}`);
        }
      });
    }
  } catch (err) {
    console.error('❗ Queue processing error:', err);
  }
}, STATION_INTERVAL_MS);

// Notification API Endpoints
app.post('/complete-service', express.json(), async (req, res) => {
  const { driverId, stationId } = req.body;
  
  try {
    // Update database
    await pool.query(
      `UPDATE queue SET status = 'completed' 
       WHERE driver_id = $1 AND station_id = $2`,
      [driverId, stationId]
    );

    // Send notification
    const socketId = driverSocketMap.get(driverId);
    if (socketId) {
      io.to(socketId).emit('queue_completed', {
        driverId,
        stationId,
        completedAt: new Date()
      });
      return res.json({ success: true, message: 'Service completed' });
    }
    
    res.status(404).json({ error: 'Driver not connected' });
  } catch (err) {
    console.error('Service completion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`✅ Socket.IO server running at http://localhost:${PORT}`);
});
