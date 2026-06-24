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

// Room state: { [code]: { users, password, createdAt, lastActivity, bannedUsers, auditLog, voiceMessages, analytics, priority, encrypted } }
const rooms = new Map();
const ROOM_TIMEOUT = parseInt(process.env.ROOM_TIMEOUT) || 30 * 60 * 1000;
const MAX_VOICE_MESSAGES = 50;
const MAX_AUDIT_LOG = 200;

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
      location: u.location || null,
      avatarColor: u.avatarColor || '#666666'
    }));
  }

  function addAuditLog(roomCode, event, username, details) {
    const room = rooms.get(roomCode);
    if (!room) return;
    room.auditLog.push({ time: Date.now(), event, username, details });
    if (room.auditLog.length > MAX_AUDIT_LOG) room.auditLog.shift();
    io.to(roomCode).emit('audit-event', { time: Date.now(), event, username, details });
  }

  function updateAnalytics(roomCode, type, value) {
    const room = rooms.get(roomCode);
    if (!room || !room.analytics) return;
    if (type === 'message') room.analytics.messages++;
    else if (type === 'voice') room.analytics.voiceMinutes += value || 0;
    else if (type === 'join') { room.analytics.joins++; room.analytics.peakUsers = Math.max(room.analytics.peakUsers, room.users.size); }
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

    rooms.set(roomCode, {
      users: new Map(),
      password: password || null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      bannedUsers: new Set(),
      auditLog: [],
      voiceMessages: [],
      analytics: { messages: 0, voiceMinutes: 0, joins: 0, peakUsers: 1 },
      priority: false,
      encrypted: false
    });
    const room = rooms.get(roomCode);
    const avatarColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    room.users.set(socket.id, { username, speaking: false, voiceEffect: 'none', isHost: true, device: null, location: null, avatarColor });

    socket.emit('room-joined', { roomCode, users: [username], isHost: true, isNew: true });

    console.log(`[${roomCode}] ${username} CREATED room [HOST]`);
    addAuditLog(roomCode, 'create', username, 'Created room');
    updateAnalytics(roomCode, 'join');
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
    if (room.bannedUsers.has(socket.id)) { socket.emit('error-msg', 'You are banned from this channel'); return; }

    if (currentRoom) leaveRoom();

    currentRoom = roomCode;
    currentUser = username;
    socket.join(roomCode);

    const avatarColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    room.users.set(socket.id, { username, speaking: false, voiceEffect: 'none', isHost: false, device: null, location: null, avatarColor });

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
    addAuditLog(roomCode, 'join', username, `Joined (${room.users.size} users)`);
    updateAnalytics(roomCode, 'join');
    broadcastActiveChannels();
  });

  // User info
  socket.on('user-info', ({ device, location }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now();
    const user = room.users.get(socket.id);
    if (!user) return;
    if (device) user.device = device;
    if (location) {
      user.location = location;
      io.to(currentRoom).emit('user-location', { username: currentUser, location });
    }
    const hostEntry = Array.from(room.users.entries()).find(([, u]) => u.isHost);
    if (hostEntry) io.to(hostEntry[0]).emit('users-detail', getRoomUsersDetailed(currentRoom));
  });

  // Location update (for live map)
  socket.on('location-update', ({ location }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now();
    const user = room.users.get(socket.id);
    if (user && location) {
      user.location = location;
      socket.to(currentRoom).emit('user-location', { username: currentUser, location });
    }
  });

  // Kick user (host only)
  socket.on('kick-user', ({ targetSocketId }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const sender = room.users.get(socket.id);
    if (!sender || !sender.isHost) return;
    if (targetSocketId === socket.id) return; // Can't kick self
    const target = room.users.get(targetSocketId);
    if (!target) return;
    io.to(targetSocketId).emit('kicked', { reason: 'Removed by host' });
    io.to(targetSocketId).disconnect(true);
  });

  // Ban user (host only)
  socket.on('ban-user', ({ targetSocketId }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const sender = room.users.get(socket.id);
    if (!sender || !sender.isHost) return;
    if (targetSocketId === socket.id) return;
    const target = room.users.get(targetSocketId);
    if (!target) return;
    room.bannedUsers.add(targetSocketId);
    io.to(targetSocketId).emit('banned', { reason: 'Banned by host' });
    io.to(targetSocketId).disconnect(true);
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
    room.lastActivity = Date.now();
    const user = room.users.get(socket.id);
    if (user) { user.speaking = true; socket.to(currentRoom).emit('speaking-start', { username: currentUser }); }
  });

  socket.on('speaking-stop', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now();
    const user = room.users.get(socket.id);
    if (user) { user.speaking = false; socket.to(currentRoom).emit('speaking-stop', { username: currentUser }); }
  });

  // Chat
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !text) return;
    const room = rooms.get(currentRoom);
    if (room) room.lastActivity = Date.now();
    updateAnalytics(currentRoom, 'message');

    // Bot commands
    if (text.startsWith('/')) {
      handleBotCommand(text.trim());
      return;
    }

    addAuditLog(currentRoom, 'chat', currentUser, text.substring(0, 50));
    socket.to(currentRoom).emit('chat-message', { username: currentUser, text });

    // Special handling for SOS and Bell
    if (text.indexOf('SOS') > -1 || text.indexOf('EMERGENCY') > -1) {
      io.to(currentRoom).emit('alert', { type: 'sos', username: currentUser });
      addAuditLog(currentRoom, 'sos', currentUser, 'SOS sent');
    } else if (text.indexOf('RING') > -1) {
      io.to(currentRoom).emit('alert', { type: 'bell', username: currentUser });
    }
  });

  // Voice messages
  socket.on('voice-message', ({ audio, duration }) => {
    if (!currentRoom || !audio) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.lastActivity = Date.now();
    const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), username: currentUser, audio, duration: duration || 0, time: Date.now() };
    room.voiceMessages.push(msg);
    if (room.voiceMessages.length > MAX_VOICE_MESSAGES) room.voiceMessages.shift();
    addAuditLog(currentRoom, 'voice', currentUser, `Voice message (${Math.round(duration || 0)}s)`);
    io.to(currentRoom).emit('voice-message', msg);
  });

  // Priority channel (host only)
  socket.on('set-priority', ({ priority }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user || !user.isHost) return;
    room.priority = !!priority;
    io.to(currentRoom).emit('priority-changed', { priority: room.priority });
    addAuditLog(currentRoom, 'priority', currentUser, priority ? 'Channel set as priority' : 'Priority removed');
  });

  // Encryption toggle (host only)
  socket.on('set-encrypted', ({ encrypted }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user || !user.isHost) return;
    room.encrypted = !!encrypted;
    io.to(currentRoom).emit('encryption-changed', { encrypted: room.encrypted });
  });

  // Bot commands
  function handleBotCommand(text) {
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');
    let response = '';

    switch (cmd) {
      case '/help':
        response = 'Commands: /help, /time, /joke, /weather [city], /users, /priority, /stats';
        break;
      case '/time':
        response = 'Server time: ' + new Date().toLocaleString();
        break;
      case '/users':
        const room = rooms.get(currentRoom);
        response = `Online: ${room ? room.users.size : 0} users`;
        break;
      case '/joke':
        const jokes = ['Why do programmers prefer dark mode? Because light attracts bugs!', 'Why was the JavaScript developer sad? Because he didn\'t Node how to Express himself!', 'What\'s a programmer\'s favorite hangout place? Foo Bar!'];
        response = jokes[Math.floor(Math.random() * jokes.length)];
        break;
      case '/weather':
        response = args ? `Weather for ${args}: Check https://wttr.in/${encodeURIComponent(args)} for live weather` : 'Usage: /weather [city]';
        break;
      case '/priority':
        const r = rooms.get(currentRoom);
        const u = r?.users.get(socket.id);
        if (u?.isHost) {
          r.priority = !r.priority;
          io.to(currentRoom).emit('priority-changed', { priority: r.priority });
          response = r.priority ? 'Channel set as PRIORITY' : 'Priority removed';
        } else {
          response = 'Only host can toggle priority';
        }
        break;
      case '/stats':
        const rm = rooms.get(currentRoom);
        if (rm?.analytics) {
          const a = rm.analytics;
          response = `Stats: ${a.messages} messages, ${a.joins} joins, Peak: ${a.peakUsers} users`;
        }
        break;
      default:
        response = 'Unknown command. Type /help for options.';
    }

    socket.emit('chat-message', { username: '🤖 Bot', text: response });
  }

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
    addAuditLog(currentRoom, 'leave', currentUser, `Left (${room.users.size} users remaining)`);

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

// Analytics endpoint
app.get('/api/analytics/:room', (req, res) => {
  const room = rooms.get(req.params.room.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ analytics: room.analytics, priority: room.priority, encrypted: room.encrypted });
});

// Audit log endpoint
app.get('/api/audit/:room', (req, res) => {
  const room = rooms.get(req.params.room.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ auditLog: room.auditLog.slice(-100) });
});

// Voice messages endpoint
app.get('/api/voice-messages/:room', (req, res) => {
  const room = rooms.get(req.params.room.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ messages: room.voiceMessages.slice(-20) });
});

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

// Channel expiration cleanup
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TIMEOUT) {
      console.log(`[${code}] Room expired (inactive for ${Math.round((now - room.lastActivity) / 60000)} min)`);
      for (const [id] of room.users) {
        io.to(id).emit('room-expired', { reason: 'Channel expired due to inactivity' });
        io.to(id).disconnect(true);
      }
      rooms.delete(code);
      broadcastActiveChannels();
    }
  }
}, 60000); // Check every 60 seconds

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🎙️ Walkie-Talkie server running on http://0.0.0.0:${PORT}`));
