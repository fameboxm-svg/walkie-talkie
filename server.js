const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6, // 5MB for audio
  pingTimeout: 60000,
  pingInterval: 25000,
  perMessageDeflate: { threshold: 1024 } // Compress data
});

app.use(express.static(path.join(__dirname, 'public')));

// Room state: { [code]: { users: Map<id, {username, speaking, voiceEffect, isHost, device, location}>, password, createdAt } }
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  function broadcastActiveChannels() {
    const channels = [];
    for (const [code, room] of rooms) {
      channels.push({ roomCode: code, users: room.users.size });
    }
    io.emit('active-channels', channels);
  }

  function getRoomUsersDetailed(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return [];
    return Array.from(room.users.entries()).map(([id, u]) => ({
      socketId: id,
      username: u.username,
      speaking: u.speaking,
      voiceEffect: u.voiceEffect || 'none',
      isHost: u.isHost,
      device: u.device || null,
      location: u.location || null
    }));
  }

  // CREATE room (host)
  socket.on('create-room', ({ roomCode, username, password }) => {
    roomCode = (roomCode || '').trim().toUpperCase();
    username = (username || '').trim() || 'Anonymous';

    if (!roomCode) { socket.emit('error-msg', 'Room code is required'); return; }
    if (rooms.has(roomCode)) { socket.emit('error-msg', 'Room already exists. Use Join instead.'); return; }

    if (currentRoom) leaveRoom();

    currentRoom = roomCode;
    currentUser = username;
    socket.join(roomCode);

    rooms.set(roomCode, { users: new Map(), password: password || null, createdAt: Date.now() });
    const room = rooms.get(roomCode);
    room.users.set(socket.id, { username, speaking: false, voiceEffect: 'none', isHost: true, device: null, location: null });

    socket.emit('room-joined', { roomCode, users: [username], isHost: true, isNew: true });

    console.log(`[${roomCode}] ${username} CREATED room [HOST]`);
    broadcastActiveChannels();
  });

  // JOIN existing room
  socket.on('join-room', ({ roomCode, username, password }) => {
    roomCode = (roomCode || '').trim().toUpperCase();
    username = (username || '').trim() || 'Anonymous';

    if (!roomCode) { socket.emit('error-msg', 'Room code is required'); return; }
    if (!rooms.has(roomCode)) { socket.emit('error-msg', 'Room not found. Create it first or check the code.'); return; }

    const room = rooms.get(roomCode);
    if (room.password && room.password !== password) { socket.emit('error-msg', 'Invalid room password'); return; }

    if (currentRoom) leaveRoom();

    currentRoom = roomCode;
    currentUser = username;
    socket.join(roomCode);

    room.users.set(socket.id, { username, speaking: false, voiceEffect: 'none', isHost: false, device: null, location: null });

    socket.emit('room-joined', {
      roomCode,
      users: Array.from(room.users.values()).map(u => u.username),
      isHost: false,
      isNew: false
    });

    socket.to(roomCode).emit('user-joined', {
      username,
      socketId: socket.id,
      users: Array.from(room.users.values()).map(u => u.username)
    });

    // Send host the updated user list
    const hostEntry = Array.from(room.users.entries()).find(([, u]) => u.isHost);
    if (hostEntry) {
      io.to(hostEntry[0]).emit('users-detail', getRoomUsersDetailed(roomCode));
    }

    // Ask new user for their info
    socket.emit('request-user-info', {});

    console.log(`[${roomCode}] ${username} joined (${room.users.size} users)`);
    broadcastActiveChannels();
  });

  // User info
  socket.on('user-info', ({ device, location }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    if (device) user.device = device;
    if (location) user.location = location;
    const hostEntry = Array.from(room.users.entries()).find(([, u]) => u.isHost);
    if (hostEntry) io.to(hostEntry[0]).emit('users-detail', getRoomUsersDetailed(currentRoom));
  });

  // Voice effect
  socket.on('voice-effect', ({ effect }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) {
      user.voiceEffect = effect || 'none';
      socket.to(currentRoom).emit('user-voice-effect', { username: currentUser, effect });
      const hostEntry = Array.from(room.users.entries()).find(([, u]) => u.isHost);
      if (hostEntry) io.to(hostEntry[0]).emit('users-detail', getRoomUsersDetailed(currentRoom));
    }
  });

  // WebRTC signaling
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer, fromUser: currentUser }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // Speaking
  socket.on('speaking-start', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) { user.speaking = true; socket.to(currentRoom).emit('speaking-start', { username: currentUser }); }
  });

  socket.on('speaking-stop', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) { user.speaking = false; socket.to(currentRoom).emit('speaking-stop', { username: currentUser }); }
  });

  // Chat
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !text) return;
    socket.to(currentRoom).emit('chat-message', { username: currentUser, text });
    // Special handling for SOS and Bell
    if (text.indexOf('SOS') > -1 || text.indexOf('EMERGENCY') > -1) {
      io.to(currentRoom).emit('alert', { type: 'sos', username: currentUser });
    } else if (text.indexOf('RING') > -1) {
      io.to(currentRoom).emit('alert', { type: 'bell', username: currentUser });
    }
  });

  // Audio fallback (disabled - using pure WebRTC)
  // socket.on('audio-chunk', ...)

  // Disconnect
  socket.on('disconnect', () => leaveRoom());

  function leaveRoom() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const wasHost = room.users.get(socket.id)?.isHost;
    room.users.delete(socket.id);

    socket.to(currentRoom).emit('user-left', {
      username: currentUser,
      users: Array.from(room.users.values()).map(u => u.username)
    });

    // Reassign host if needed
    if (wasHost && room.users.size > 0) {
      const newHost = room.users.entries().next().value;
      if (newHost) {
        newHost[1].isHost = true;
        io.to(newHost[0]).emit('promoted-host', {});
        io.to(newHost[0]).emit('users-detail', getRoomUsersDetailed(currentRoom));
      }
    }

    console.log(`[${currentRoom}] ${currentUser} left (${room.users.size} users)`);

    if (room.users.size === 0) {
      rooms.delete(currentRoom);
      console.log(`[${currentRoom}] Room deleted`);
    }

    broadcastActiveChannels();
    currentRoom = null;
    currentUser = null;
  }
});

// List rooms (for discovery)
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const [code, room] of rooms) {
    list.push({ roomCode: code, users: room.users.size, hasPassword: !!room.password });
  }
  res.json(list);
});

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

// Provide ICE servers config to clients
app.get('/api/ice', (req, res) => {
  res.json([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.ideasip.com' },
    { urls: 'stun:stun.schlund.de' },
    { urls: 'stun:stun.voiparound.com' },
    { urls: 'stun:stun.voipbuster.com' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:open.relay.me:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:open.relay.me:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:open.relay.me:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🎙️ Walkie-Talkie server running on http://0.0.0.0:${PORT}`));
