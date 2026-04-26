/**
 * server.js — Entry point
 * Sets up Express + Socket.io, starts the simulation engine,
 * and wires the real-time broadcast.
 */

const express = require('express');
const http    = require('http');
const cors    = require('cors');
const { Server } = require('socket.io');
const simulation = require('./engine/simulation');

const PORT = process.env.PORT || 4000;

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send a full state snapshot to the new client immediately
  socket.emit('telemetry_update', simulation.getState());

  // Bidirectional command interface — Digital Twin control loop
  socket.on('twin_command', (command, callback) => {
    console.log(`[WS] Command from ${socket.id}:`, command);
    const result = simulation.handleCommand(command);
    if (callback) callback(result);
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ─── REST snapshot endpoint ───────────────────────────────────────────────────
app.get('/api/state', (_req, res) => {
  res.json(simulation.getState());
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime().toFixed(1) });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  // Inject the broadcast function into the simulation engine
  simulation.init((payload) => {
    io.emit('telemetry_update', payload);
  });
});
