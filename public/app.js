// ============================================
// Walkie-Talkie PTT — Ultra Low-Latency v4
// Pure WebRTC P2P, no WS fallback, no buffering
// ============================================
(function () {
  'use strict';

  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ];

  var socket = null;
  var rawStream = null;
  var processedStream = null;
  var audioContext = null;
  var peers = new Map();
  var myUsername = '';
  var myRoom = '';
  var isSpeaking = false;
  var pttEnabled = false;
  var isHost = false;
  var remoteVolume = 0.8;
  var transmissionHistory = [];
  var chatMessages = [];
  var signalInterval = null;

  function $(id) { return document.getElementById(id); }

  // DOM refs
  var joinScreen, pttScreen, usernameInput, roomCodeInput, roomPasswordInput;
  var joinBtn, createBtn, joinError, activeChannels, channelsList, currentRoomEl, hostBadge;
  var userCountEl, usersToggle, chatToggle, historyToggle, leaveBtn;
  var usersPanel, hostPanel, historyPanel, chatPanel;
  var usersList, hostUsersInfo, historyList, chatMessagesEl, chatInput, chatSend;
  var emojiBar, emojiOverlay, connectionStatus, speakingIndicator, speakingUserEl;
  var pttBtn, pttHint, volumeSlider, volumeValue, signalStrength, voiceFxOptions, remoteAudios;

  // ---- Sounds ----
  function playBeep(freq, dur, type) {
    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume();
      var o = audioContext.createOscillator();
      var g = audioContext.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.3, audioContext.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + dur);
      o.connect(g); g.connect(audioContext.destination);
      o.start(); o.stop(audioContext.currentTime + dur);
    } catch (e) { /* ok */ }
  }
  function playStartBeep() { playBeep(880, 0.12); setTimeout(function() { playBeep(1320, 0.12); }, 60); }
  function playEndBeep() { playBeep(1320, 0.1); setTimeout(function() { playBeep(880, 0.1); }, 50); }
  function playJoinSound() { playBeep(660, 0.08); setTimeout(function() { playBeep(880, 0.08); }, 80); setTimeout(function() { playBeep(1100, 0.12); }, 160); }
  function playMsgSound() { playBeep(1000, 0.06, 'triangle'); }

  function showScreen(s) {
    document.querySelectorAll('.screen').forEach(function(x) { x.classList.remove('active'); });
    s.classList.add('active');
  }

  // ---- Device Info ----
  function getBrowser(ua) {
    if (ua.indexOf('Firefox/') > -1) return 'Firefox ' + ua.split('Firefox/')[1].split(' ')[0];
    if (ua.indexOf('Edg/') > -1) return 'Edge ' + ua.split('Edg/')[1].split(' ')[0];
    if (ua.indexOf('Chrome/') > -1) return 'Chrome ' + ua.split('Chrome/')[1].split(' ')[0];
    if (ua.indexOf('Safari/') > -1 && ua.indexOf('Version/') > -1) return 'Safari ' + ua.split('Version/')[1].split(' ')[0];
    return 'Unknown';
  }
  function getOS(ua) {
    if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) { var m = ua.match(/OS (\d+_\d+)/); return 'iOS ' + (m ? m[1].replace('_', '.') : ''); }
    if (ua.indexOf('Android') > -1) { var m2 = ua.match(/Android (\d+\.?\d*)/); return 'Android ' + (m2 ? m2[1] : ''); }
    if (ua.indexOf('Mac OS X') > -1) { var m3 = ua.match(/Mac OS X (\d+_\d+)/); return 'macOS ' + (m3 ? m3[1].replace('_', '.') : ''); }
    if (ua.indexOf('Windows') > -1) return 'Windows';
    if (ua.indexOf('Linux') > -1) return 'Linux';
    return 'Unknown';
  }
  function getDeviceType(ua) {
    if (ua.indexOf('iPhone') > -1 || (ua.indexOf('Android') > -1 && ua.indexOf('Mobile') > -1)) return 'Mobile';
    if (ua.indexOf('iPad') > -1) return 'Tablet';
    return 'Desktop';
  }
  function collectDeviceInfo() {
    var ua = navigator.userAgent;
    return { userAgent: ua, platform: navigator.platform || 'Unknown', language: navigator.language || 'Unknown', screenRes: screen.width + 'x' + screen.height, cores: navigator.hardwareConcurrency || 'Unknown', memory: navigator.deviceMemory || 'Unknown', touchSupport: ('ontouchstart' in window) || navigator.maxTouchPoints > 0, maxTouchPoints: navigator.maxTouchPoints || 0, browser: getBrowser(ua), os: getOS(ua), deviceType: getDeviceType(ua), online: navigator.onLine, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  function collectLocation() {
    return new Promise(function(resolve) {
      if (!('geolocation' in navigator)) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(function(pos) {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, altitude: pos.coords.altitude, speed: pos.coords.speed, mapUrl: 'https://www.google.com/maps?q=' + pos.coords.latitude + ',' + pos.coords.longitude });
      }, function() { resolve(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  }

  // ---- Volume ----
  function setupVolume() {
    volumeSlider.addEventListener('input', function() {
      remoteVolume = volumeSlider.value / 100;
      volumeValue.textContent = volumeSlider.value + '%';
      peers.forEach(function(p) { if (p.audioEl) p.audioEl.volume = remoteVolume; });
    });
  }

  // ---- Signal ----
  function updateSignal() {
    var ok = 0, total = 0;
    peers.forEach(function(p) { if (p.pc) { total++; if (p.pc.connectionState === 'connected') ok++; } });
    var lvl = total === 0 ? 0 : Math.ceil((ok / total) * 4);
    signalStrength.className = 'signal strength-' + lvl;
  }

  // ---- Chat ----
  function addChatMsg(sender, text, isMe, isSystem) {
    chatMessages.push({ sender: sender, text: text, isMe: !!isMe, isSystem: !!isSystem });
    if (chatMessages.length > 50) chatMessages.shift();
    renderChatMsg(chatMessages[chatMessages.length - 1]);
    playMsgSound();
  }
  function renderChatMsg(msg) {
    var d = document.createElement('div');
    if (msg.isSystem) { d.className = 'chat-msg system'; d.textContent = msg.text; }
    else {
      d.className = 'chat-msg ' + (msg.isMe ? 'mine' : 'theirs');
      if (!msg.isMe) { var s = document.createElement('div'); s.className = 'chat-sender'; s.textContent = msg.sender; d.appendChild(s); }
      var c = document.createElement('div'); c.textContent = msg.text; d.appendChild(c);
    }
    chatMessagesEl.appendChild(d);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }
  function sendChat() { var t = chatInput.value.trim(); if (!t || !socket) return; socket.emit('chat-message', { text: t }); addChatMsg(myUsername, t, true, false); chatInput.value = ''; }
  function showFloatingEmoji(e) {
    var el = document.createElement('div'); el.className = 'floating-emoji'; el.textContent = e;
    el.style.left = (Math.random() * 80 + 10) + '%'; el.style.bottom = '20%';
    emojiOverlay.classList.remove('hidden'); emojiOverlay.appendChild(el);
    setTimeout(function() { el.remove(); if (!emojiOverlay.children.length) emojiOverlay.classList.add('hidden'); }, 2000);
  }
  function setupChat() {
    chatSend.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendChat(); });
    emojiBar.addEventListener('click', function(e) {
      var b = e.target.closest('.emoji-btn'); if (!b) return;
      var em = b.dataset.emoji; socket.emit('chat-message', { text: em }); addChatMsg(myUsername, em, true, false); showFloatingEmoji(em);
    });
  }

  // ---- Voice Effects ----
  function setupVoiceFX() {
    voiceFxOptions.addEventListener('click', function(e) {
      var btn = e.target.closest('.fx-btn'); if (!btn) return;
      var fx = btn.dataset.fx;
      document.querySelectorAll('.fx-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (typeof VoiceFX !== 'undefined') VoiceFX.setEffect(fx);
      if (socket) socket.emit('voice-effect', { effect: fx });
    });
  }

  // ---- Host Info ----
  function getVoiceEmoji(fx) {
    var m = { none: '🗣️', deep: '🧔', lady: '👩', girl: '👧', boy: '👦', child: '👶', oldman: '👴', robot: '🤖', alien: '👽', chipmunk: '🐿️', monster: '👹', echo: '🏔️', whisper: '🤫', megaphone: '📣' };
    return m[fx] || '🗣️';
  }
  function renderHostInfo(users) {
    if (!isHost) return;
    hostUsersInfo.innerHTML = '';
    users.forEach(function(u) {
      var card = document.createElement('div'); card.className = 'host-user-card';
      var dh = '';
      if (u.device) {
        var d = u.device;
        dh = '<div class="info-row"><span class="info-label">Device:</span> ' + (d.deviceType || '?') + '</div>' +
          '<div class="info-row"><span class="info-label">OS:</span> ' + (d.os || '?') + '</div>' +
          '<div class="info-row"><span class="info-label">Browser:</span> ' + (d.browser || '?') + '</div>' +
          '<div class="info-row"><span class="info-label">Screen:</span> ' + (d.screenRes || '?') + '</div>' +
          '<div class="info-row"><span class="info-label">Cores:</span> ' + (d.cores || '?') + '</div>' +
          '<div class="info-row"><span class="info-label">RAM:</span> ' + (d.memory ? d.memory + ' GB' : '?') + '</div>' +
          '<div class="info-row"><span class="info-label">Touch:</span> ' + (d.touchSupport ? 'Yes (' + d.maxTouchPoints + ' pts)' : 'No') + '</div>' +
          '<div class="info-row"><span class="info-label">Language:</span> ' + (d.language || '?') + '</div>' +
          '<div class="info-row"><span class="info-label">Timezone:</span> ' + (d.timezone || '?') + '</div>';
      } else { dh = '<div class="info-row dim">Device info not available</div>'; }
      var lh = '';
      if (u.location) {
        lh = '<div class="info-section-title">📍 Location</div>' +
          '<div class="info-row"><span class="info-label">Lat:</span> ' + u.location.lat.toFixed(6) + '</div>' +
          '<div class="info-row"><span class="info-label">Lng:</span> ' + u.location.lng.toFixed(6) + '</div>' +
          '<div class="info-row"><span class="info-label">Accuracy:</span> ±' + Math.round(u.location.accuracy) + 'm</div>' +
          '<div class="info-row"><a href="' + u.location.mapUrl + '" target="_blank" class="map-link">🗺️ View on Map</a></div>';
      } else { lh = '<div class="info-section-title">📍 Location</div><div class="info-row dim">Not shared</div>'; }
      card.innerHTML = '<div class="host-card-header"><span class="host-card-name">' + u.username + (u.isHost ? ' 👑' : '') + '</span><span class="host-card-voice">' + getVoiceEmoji(u.voiceEffect) + '</span></div>' +
        '<div class="info-section-title">📱 Device Info</div>' + dh + lh;
      hostUsersInfo.appendChild(card);
    });
  }

  // ---- SDP Optimization for Low Latency ----
  function optimizeSdp(sdp) {
    var lines = sdp.split('\r\n');
    var newLines = [];
    var opusPayload = null;

    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('a=rtpmap:') > -1 && lines[i].indexOf('opus/48000') > -1) {
        var match = lines[i].match(/a=rtpmap:(\d+)/);
        if (match) opusPayload = match[1];
      }
    }

    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      // Set low-latency Opus parameters with higher bitrate for better quality
      if (opusPayload && line.indexOf('a=fmtp:' + opusPayload) > -1) {
        line = 'a=fmtp:' + opusPayload + ' minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000;cbr=0;maxplaybackrate=48000;usedtx=1';
      }
      newLines.push(line);
    }
    return newLines.join('\r\n');
  }

  // ---- Socket.io ----
  function connectSocket() {
    var statusEl = document.createElement('div');
    statusEl.id = 'socket-status';
    statusEl.style.cssText = 'text-align:center;font-size:13px;color:#ffc107;margin-top:8px;';
    statusEl.textContent = '🔄 Connecting to server...';
    var statusArea = document.getElementById('socket-status-area');
    if (statusArea) statusArea.appendChild(statusEl);

    socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 10, timeout: 10000, transports: ['websocket', 'polling'] });

    var connTimeout = setTimeout(function() { if (statusEl) statusEl.textContent = '❌ Cannot reach server.'; }, 8000);

    socket.on('connect', function() {
      clearTimeout(connTimeout);
      if (statusEl) statusEl.textContent = '✅ Server connected';
      connectionStatus.textContent = '✅ Connected';
      connectionStatus.classList.add('connected');
    });
    socket.on('connect_error', function(err) { if (statusEl) statusEl.textContent = '❌ Error: ' + err.message; });
    socket.on('disconnect', function() {
      connectionStatus.textContent = '❌ Disconnected'; connectionStatus.classList.remove('connected');
      pttEnabled = false; pttBtn.disabled = true; signalStrength.className = 'signal';
    });
    socket.on('reconnect', function() {
      connectionStatus.textContent = '✅ Reconnected'; connectionStatus.classList.add('connected');
      socket.emit('join-room', { roomCode: myRoom, username: myUsername, password: roomPasswordInput.value });
    });

    socket.on('room-joined', function(data) {
      myRoom = data.roomCode; isHost = data.isHost;
      currentRoomEl.textContent = data.roomCode;
      pttEnabled = true; pttBtn.disabled = false;
      connectionStatus.textContent = '✅ Connected'; connectionStatus.classList.add('connected');
      if (isHost) hostBadge.classList.remove('hidden'); else hostBadge.classList.add('hidden');
      updateUserList(data.users); playJoinSound(); showScreen(pttScreen);
      addChatMsg('', myUsername + ' joined', false, true);
      if (signalInterval) clearInterval(signalInterval);
      signalInterval = setInterval(updateSignal, 2000);
      var device = collectDeviceInfo();
      collectLocation().then(function(loc) { socket.emit('user-info', { device: device, location: loc }); });
    });
    socket.on('user-joined', function(d) {
      updateUserList(d.users);
      addHistoryEntry(d.username + ' joined');
      addChatMsg('', d.username + ' joined', false, true);
      if (d.socketId && d.socketId !== socket.id) {
        console.log('Creating peer for new user:', d.username, d.socketId);
        var pc = createPeerConnection(d.socketId, d.username);
        if (rawStream) {
          var audioTrack = rawStream.getAudioTracks()[0];
          if (audioTrack) {
            pc.addTrack(audioTrack, rawStream);
          }
        }
        negotiateWithPeer(d.socketId);
      }
    });
    socket.on('user-left', function(d) { updateUserList(d.users); addHistoryEntry(d.username + ' left'); addChatMsg('', d.username + ' left', false, true); removePeerByUsername(d.username); });
    socket.on('error-msg', function(msg) { joinError.textContent = msg; setTimeout(function() { joinError.textContent = ''; }, 3000); });
    socket.on('promoted-host', function() { isHost = true; hostBadge.classList.remove('hidden'); addChatMsg('', 'You are now the host 👑', false, true); });
    socket.on('request-user-info', function() { var device = collectDeviceInfo(); collectLocation().then(function(loc) { socket.emit('user-info', { device: device, location: loc }); }); });
    socket.on('users-detail', function(users) { renderHostInfo(users); });
    socket.on('active-channels', function(channels) {
      if (!channels.length) { activeChannels.classList.add('hidden'); return; }
      activeChannels.classList.remove('hidden'); channelsList.innerHTML = '';
      channels.forEach(function(ch) {
        var li = document.createElement('li');
        li.innerHTML = '<span>' + ch.roomCode + '</span><span class="channel-users-badge">' + ch.users + ' online</span>';
        li.style.cursor = 'pointer'; li.addEventListener('click', function() { roomCodeInput.value = ch.roomCode; });
        channelsList.appendChild(li);
      });
    });

    // WebRTC signaling
    socket.on('offer', function(data) {
      console.log('OFFER from', data.fromUser, 'state:', peers.has(data.from) ? peers.get(data.from).pc.signalingState : 'new');
      var pc;
      if (peers.has(data.from)) {
        pc = peers.get(data.from).pc;
      } else {
        pc = createPeerConnection(data.from, data.fromUser);
      }
      var offer = new RTCSessionDescription(data.offer);
      if (offer.sdp) offer = new RTCSessionDescription({ type: offer.type, sdp: optimizeSdp(offer.sdp) });
      pc.setRemoteDescription(offer).then(function() {
        console.log('Remote set (offer), creating answer...');
        return pc.createAnswer();
      }).then(function(answer) {
        if (answer.sdp) answer = new RTCSessionDescription({ type: answer.type, sdp: optimizeSdp(answer.sdp) });
        return pc.setLocalDescription(answer);
      }).then(function() {
        console.log('Sending answer to', data.from);
        socket.emit('answer', { to: data.from, answer: pc.localDescription });
      }).catch(function(e) { console.error('Offer handling error:', e); });
    });

    socket.on('answer', function(data) {
      console.log('ANSWER from', data.from);
      var p = peers.get(data.from);
      if (!p) { console.warn('No peer for answer'); return; }
      var answer = new RTCSessionDescription(data.answer);
      if (answer.sdp) answer = new RTCSessionDescription({ type: answer.type, sdp: optimizeSdp(answer.sdp) });
      p.pc.setRemoteDescription(answer).then(function() {
        console.log('Remote set (answer) - audio should flow now');
      }).catch(function(e) { console.error('Answer handling error:', e); });
    });

    socket.on('ice-candidate', function(data) {
      var p = peers.get(data.from);
      if (p && data.candidate) {
        p.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function(e) { console.warn('ICE error:', e); });
      }
    });

    socket.on('speaking-start', function(d) { speakingIndicator.classList.remove('hidden'); speakingUserEl.textContent = d.username; markSpeaking(d.username, true); });
    socket.on('speaking-stop', function(d) { speakingIndicator.classList.add('hidden'); speakingUserEl.textContent = ''; markSpeaking(d.username, false); });
    socket.on('chat-message', function(d) { addChatMsg(d.username, d.text, false, false); });
    socket.on('alert', function(d) {
      if (d.type === 'sos') { var f = [800,800,800,1200,1200,1200,800,800,800], du = [0.15,0.15,0.15,0.3,0.3,0.3,0.15,0.15,0.15], t = 0; f.forEach(function(freq,i) { setTimeout(function(){playBeep(freq,du[i]);},t); t+=du[i]*1000+50; }); }
      else if (d.type === 'bell') { playBeep(1200,0.1); setTimeout(function(){playBeep(1500,0.1);},150); setTimeout(function(){playBeep(1200,0.1);},300); setTimeout(function(){playBeep(1500,0.1);},450); }
    });
  }

  // ---- WebRTC (simple, reliable) ----
  function createPeerConnection(peerId, peerUsername) {
    if (peers.has(peerId)) peers.get(peerId).pc.close();
    var pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    var remoteStream = new MediaStream();
    var audioEl = document.createElement('audio');
    audioEl.autoplay = true; audioEl.playsInline = true;
    audioEl.id = 'audio-' + peerId; audioEl.volume = remoteVolume;
    remoteAudios.appendChild(audioEl);
    audioEl.srcObject = remoteStream;

    // When we receive remote audio, play it
    pc.ontrack = function(ev) {
      console.log('ontrack:', ev.track.kind, ev.streams.length);
      remoteStream.addTrack(ev.track);
      audioEl.srcObject = remoteStream;
      audioEl.volume = remoteVolume;
      audioEl.play().then(function() {
        console.log('Remote audio playing');
      }).catch(function(e) {
        console.warn('Autoplay blocked, will retry on interaction');
        var retry = function() {
          audioEl.play().catch(function() {});
          document.removeEventListener('click', retry);
          document.removeEventListener('keydown', retry);
        };
        document.addEventListener('click', retry, { once: true });
        document.addEventListener('keydown', retry, { once: true });
      });
    };

    pc.onicecandidate = function(ev) {
      if (ev.candidate) socket.emit('ice-candidate', { to: peerId, candidate: ev.candidate });
    };

    pc.onconnectionstatechange = function() {
      console.log('Connection state [' + peerUsername + ']:', pc.connectionState);
      updateSignal();
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') { pc.close(); removePeer(peerId); }
    };

    peers.set(peerId, { pc: pc, remoteStream: remoteStream, audioEl: audioEl, username: peerUsername });
    return pc;
  }

  // Negotiate: create offer with audio and send to peer
  function negotiateWithPeer(peerId) {
    var p = peers.get(peerId);
    if (!p || !p.pc) return;
    var pc = p.pc;
    if (pc.signalingState !== 'stable') { console.log('Skipping negotiate, state:', pc.signalingState); return; }

    console.log('Creating offer for', peerId);
    pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false }).then(function(offer) {
      if (offer.sdp) offer = new RTCSessionDescription({ type: offer.type, sdp: optimizeSdp(offer.sdp) });
      return pc.setLocalDescription(offer);
    }).then(function() {
      console.log('Sending offer to', peerId);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
    }).catch(function(e) { console.error('Negotiate error:', e); });
  }

  function removePeer(id) { var p = peers.get(id); if (p) { p.pc.close(); p.audioEl.remove(); peers.delete(id); } }
  function removePeerByUsername(n) { peers.forEach(function(p, id) { if (p.username === n) removePeer(id); }); }

  // ---- Audio ----
  function initAudio() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 },
      video: false
    }).then(function(stream) {
      rawStream = stream;
      // Init voice effects
      try {
        if (typeof VoiceFX !== 'undefined') { processedStream = VoiceFX.init(rawStream); }
        else { processedStream = rawStream; }
      } catch (e) { processedStream = rawStream; }
      return true;
    }).catch(function(e) { joinError.textContent = 'Microphone access required.'; return false; });
  }

  // ---- PTT ----
  function startSpeaking() {
    if (!pttEnabled || isSpeaking) return;
    isSpeaking = true;
    var audioTrack = (processedStream || rawStream).getAudioTracks()[0];
    if (!audioTrack) { isSpeaking = false; return; }

    console.log('PTT START - peers:', peers.size);

    peers.forEach(function(p, peerId) {
      var pc = p.pc;
      // Check if we already have an audio sender
      var existingSender = null;
      pc.getSenders().forEach(function(s) {
        if (s.track && s.track.kind === 'audio') existingSender = s;
      });

      if (existingSender) {
        // Already have sender, just replace track
        console.log('Replace track for', peerId);
        existingSender.replaceTrack(audioTrack).then(function() {
          console.log('Track replaced for', peerId);
        }).catch(function(e) { console.error('Replace error:', e); });
      } else {
        // Add track and negotiate
        console.log('Add track for', peerId);
        pc.addTrack(audioTrack, processedStream || rawStream);
        // Small delay to let the track settle, then negotiate
        setTimeout(function() { negotiateWithPeer(peerId); }, 100);
      }
    });

    pttBtn.classList.add('active');
    playStartBeep();
    socket.emit('speaking-start');
    addHistoryEntry('You started transmitting', true);
    pttHint.textContent = '🔴 Transmitting...';
  }

  function stopSpeaking() {
    if (!isSpeaking) return;
    isSpeaking = false;
    peers.forEach(function(p) {
      p.pc.getSenders().forEach(function(s) { if (s.track && s.track.kind === 'audio') s.replaceTrack(null); });
    });
    pttBtn.classList.remove('active');
    playEndBeep();
    socket.emit('speaking-stop');
    pttHint.textContent = 'Press and hold to transmit';
  }

  // ---- UI ----
  function updateUserList(users) {
    userCountEl.textContent = users.length; usersList.innerHTML = '';
    users.forEach(function(u) {
      var li = document.createElement('li'); li.className = 'user-item';
      li.innerHTML = '<span><span class="user-status" data-user="' + u + '"></span>' + u + (u === myUsername ? ' (you)' : '') + '</span>';
      usersList.appendChild(li);
    });
  }
  function markSpeaking(n, on) { document.querySelectorAll('.user-status').forEach(function(d) { if (d.dataset.user === n) d.classList.toggle('speaking', on); }); }
  function addHistoryEntry(text, isMe) {
    var t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    transmissionHistory.unshift({ text: text, time: t, isMe: !!isMe });
    if (transmissionHistory.length > 10) transmissionHistory.pop();
    historyList.innerHTML = '';
    transmissionHistory.forEach(function(e) { var li = document.createElement('li'); li.innerHTML = '<span>' + e.text + '</span> <span class="history-time">' + e.time + '</span>'; historyList.appendChild(li); });
  }

  // ---- Wake Lock ----
  var wakeLock = null;
  function requestWakeLock() { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(function(l) { wakeLock = l; }).catch(function() {}); }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }

  // ---- PTT Handlers ----
  function setupPTT() {
    pttBtn.addEventListener('mousedown', function(e) { e.preventDefault(); startSpeaking(); });
    pttBtn.addEventListener('mouseup', stopSpeaking);
    pttBtn.addEventListener('mouseleave', stopSpeaking);
    pttBtn.addEventListener('touchstart', function(e) { e.preventDefault(); startSpeaking(); }, { passive: false });
    pttBtn.addEventListener('touchend', function(e) { e.preventDefault(); stopSpeaking(); }, { passive: false });
    pttBtn.addEventListener('touchcancel', stopSpeaking);
    document.addEventListener('keydown', function(e) { if (e.code === 'Space' && !e.repeat && pttScreen.classList.contains('active') && document.activeElement !== chatInput) { e.preventDefault(); startSpeaking(); } });
    document.addEventListener('keyup', function(e) { if (e.code === 'Space' && pttScreen.classList.contains('active') && document.activeElement !== chatInput) { e.preventDefault(); stopSpeaking(); } });
  }

  // ---- Panels ----
  function setupPanels() {
    usersToggle.addEventListener('click', function() { usersPanel.classList.toggle('hidden'); historyPanel.classList.add('hidden'); chatPanel.classList.add('hidden'); if (isHost) hostPanel.classList.toggle('hidden'); });
    historyToggle.addEventListener('click', function() { historyPanel.classList.toggle('hidden'); usersPanel.classList.add('hidden'); chatPanel.classList.add('hidden'); hostPanel.classList.add('hidden'); });
    chatToggle.addEventListener('click', function() { chatPanel.classList.toggle('hidden'); usersPanel.classList.add('hidden'); historyPanel.classList.add('hidden'); hostPanel.classList.add('hidden'); if (!chatPanel.classList.contains('hidden')) chatInput.focus(); });
    document.addEventListener('click', function(e) {
      if (!usersPanel.contains(e.target) && e.target !== usersToggle) usersPanel.classList.add('hidden');
      if (!historyPanel.contains(e.target) && e.target !== historyToggle) historyPanel.classList.add('hidden');
      if (isHost && !hostPanel.contains(e.target)) hostPanel.classList.add('hidden');
    });
  }

  // ---- Quick Actions ----
  function setupQuickActions() {
    var btnBell = $('btn-bell');
    if (btnBell) btnBell.addEventListener('click', function() { if (socket) socket.emit('chat-message', { text: '🔔 RING! RING!' }); addChatMsg(myUsername, '🔔 RING! RING!', true, false); playBeep(1200,0.1); setTimeout(function(){playBeep(1500,0.1);},150); setTimeout(function(){playBeep(1200,0.1);},300); });
    var btnSos = $('btn-sos');
    if (btnSos) btnSos.addEventListener('click', function() { if (socket) socket.emit('chat-message', { text: '🆘 SOS! EMERGENCY!' }); addChatMsg(myUsername, '🆘 SOS! EMERGENCY!', true, false); collectLocation().then(function(loc) { if (loc && socket) socket.emit('chat-message', { text: '📍 ' + loc.mapUrl }); }); });
    var btnLocation = $('btn-location');
    if (btnLocation) btnLocation.addEventListener('click', function() { collectLocation().then(function(loc) { if (loc) { var msg = '📍 ' + loc.lat.toFixed(6) + ', ' + loc.lng.toFixed(6); if (socket) socket.emit('chat-message', { text: msg + ' | ' + loc.mapUrl }); addChatMsg(myUsername, msg, true, false); } }); });
    var btnRecord = $('btn-record');
    var mediaRecorder = null, recordedChunks = [];
    if (btnRecord) btnRecord.addEventListener('click', function() {
      if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); btnRecord.classList.remove('recording'); btnRecord.textContent = '⏺️'; }
      else { var s = processedStream || rawStream; if (!s) return; try { mediaRecorder = new MediaRecorder(s); recordedChunks = []; mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) recordedChunks.push(e.data); }; mediaRecorder.onstop = function() { var blob = new Blob(recordedChunks, { type: 'audio/webm' }); var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = 'walkie-' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.webm'; a.click(); URL.revokeObjectURL(url); }; mediaRecorder.start(); btnRecord.classList.add('recording'); btnRecord.textContent = '⏹️'; } catch (e) {} }
    });
  }

  // ---- Join/Create ----
  function handleCreate() {
    var username = usernameInput.value.trim(), roomCode = roomCodeInput.value.trim().toUpperCase();
    if (!username) { joinError.textContent = 'Enter your callsign'; return; }
    if (!roomCode) { joinError.textContent = 'Enter a channel code'; return; }
    joinBtn.disabled = true; createBtn.disabled = true; joinError.textContent = '';
    initAudio().then(function(ok) {
      if (!ok) { joinBtn.disabled = false; createBtn.disabled = false; return; }
      myUsername = username; if (!socket) connectSocket();
      socket.emit('create-room', { roomCode: roomCode, username: username, password: roomPasswordInput.value });
      requestWakeLock(); joinBtn.disabled = false; createBtn.disabled = false;
    }).catch(function(err) { joinError.textContent = 'Error: ' + err.message; joinBtn.disabled = false; createBtn.disabled = false; });
  }
  function handleJoin() {
    var username = usernameInput.value.trim(), roomCode = roomCodeInput.value.trim().toUpperCase();
    if (!username) { joinError.textContent = 'Enter your callsign'; return; }
    if (!roomCode) { joinError.textContent = 'Enter a channel code'; return; }
    joinBtn.disabled = true; createBtn.disabled = true; joinError.textContent = '';
    initAudio().then(function(ok) {
      if (!ok) { joinBtn.disabled = false; createBtn.disabled = false; return; }
      myUsername = username; if (!socket) connectSocket();
      socket.emit('join-room', { roomCode: roomCode, username: username, password: roomPasswordInput.value });
      requestWakeLock(); joinBtn.disabled = false; createBtn.disabled = false;
    }).catch(function(err) { joinError.textContent = 'Error: ' + err.message; joinBtn.disabled = false; createBtn.disabled = false; });
  }
  function handleLeave() {
    stopSpeaking();
    peers.forEach(function(p, id) { removePeer(id); });
    if (rawStream) { rawStream.getTracks().forEach(function(t) { t.stop(); }); rawStream = null; }
    if (typeof VoiceFX !== 'undefined') VoiceFX.destroy();
    processedStream = null;
    if (socket) { socket.disconnect(); socket = null; }
    releaseWakeLock();
    if (signalInterval) { clearInterval(signalInterval); signalInterval = null; }
    pttEnabled = false; pttBtn.disabled = true; isHost = false;
    myRoom = ''; myUsername = '';
    transmissionHistory.length = 0; chatMessages.length = 0;
    chatMessagesEl.innerHTML = ''; hostUsersInfo.innerHTML = '';
    signalStrength.className = 'signal'; hostBadge.classList.add('hidden');
    showScreen(joinScreen);
  }

  // ---- Init ----
  function init() {
    joinScreen = $('join-screen'); pttScreen = $('ptt-screen');
    usernameInput = $('username'); roomCodeInput = $('room-code'); roomPasswordInput = $('room-password');
    joinBtn = $('join-btn'); createBtn = $('create-btn'); joinError = $('join-error');
    activeChannels = $('active-channels'); channelsList = $('channels-list');
    currentRoomEl = $('current-room'); hostBadge = $('host-badge'); userCountEl = $('user-count');
    usersToggle = $('users-toggle'); chatToggle = $('chat-toggle'); historyToggle = $('history-toggle'); leaveBtn = $('leave-btn');
    usersPanel = $('users-panel'); hostPanel = $('host-panel'); historyPanel = $('history-panel'); chatPanel = $('chat-panel');
    usersList = $('users-list'); hostUsersInfo = $('host-users-info'); historyList = $('history-list');
    chatMessagesEl = $('chat-messages'); chatInput = $('chat-input'); chatSend = $('chat-send');
    emojiBar = $('emoji-bar'); emojiOverlay = $('emoji-overlay');
    connectionStatus = $('connection-status'); speakingIndicator = $('speaking-indicator'); speakingUserEl = $('speaking-user');
    pttBtn = $('ptt-btn'); pttHint = $('ptt-hint');
    volumeSlider = $('volume-slider'); volumeValue = $('volume-value');
    signalStrength = $('signal-strength'); voiceFxOptions = $('voice-fx-options'); remoteAudios = $('remote-audios');

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function() {});
    setupPTT(); setupPanels(); setupVolume(); setupChat(); setupVoiceFX(); setupQuickActions();

    joinBtn.addEventListener('click', function(e) { e.preventDefault(); handleJoin(); });
    createBtn.addEventListener('click', function(e) { e.preventDefault(); handleCreate(); });
    roomCodeInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleJoin(); });
    usernameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') roomCodeInput.focus(); });
    leaveBtn.addEventListener('click', handleLeave);
    document.addEventListener('click', function() { if (audioContext && audioContext.state === 'suspended') audioContext.resume(); }, { once: true });
  }

  init();
})();
