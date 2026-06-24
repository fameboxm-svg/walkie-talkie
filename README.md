# 📻 Walkie-Talkie — Real-Time Push-to-Talk Web App

A real-time push-to-talk (PTT) walkie-talkie web application. Hold a button to speak, release to listen. Works on mobile and desktop browsers over the internet.

## Features

- **Real-time audio** via WebRTC (peer-to-peer, low latency)
- **WebSocket audio fallback** when WebRTC fails
- **Push-to-Talk** mechanic — hold to speak, release to listen
- **Room/Channel system** — enter a shared room code to connect
- **No login required** — just a callsign and channel code
- **Multiple users** per room
- **Password-protected channels** (optional)
- **Noise suppression** + echo cancellation via Web Audio API constraints
- **Walkie-talkie beep sounds** on start/stop transmission
- **Transmission history** (last 10 entries)
- **PWA installable** — add to home screen on mobile
- **Service Worker** for offline caching
- **Wake Lock API** to keep screen on during use
- **Works on mobile browsers** (Chrome, Safari) — no app install needed

## Quick Start

### 1. Install dependencies

```bash
cd walkie-talkie
npm install
```

### 2. Start the server

```bash
npm start
```

The server runs on `http://localhost:3000` by default.

### 3. Open in browser

Open `http://localhost:3000` on two or more devices on the same network.

For internet access, deploy to a hosting service (see below).

## Deployment

### Backend (Signaling Server)

Deploy to **Render**, **Railway**, or **Fly.io**:

#### Render
1. Push this project to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Free tier works great

#### Railway
1. Go to [railway.app](https://railway.app)
2. Deploy from GitHub repo
3. Auto-detects Node.js

#### Fly.io
```bash
fly launch
fly deploy
```

### Frontend (Static Files)

The frontend is served by the same Express server. No separate frontend deployment needed.

If you want to serve frontend separately:
- Deploy the `public/` folder to **Vercel** or **Netlify**
- Update the Socket.io connection URL in `app.js` to point to your backend

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port  |

## Tech Stack

- **Frontend:** HTML + CSS + Vanilla JavaScript
- **Backend:** Node.js + Express + Socket.io
- **Audio:** WebRTC + Web Audio API
- **Background:** Service Worker + Wake Lock API
- **PWA:** Web App Manifest

## How It Works

1. User enters a callsign and room code
2. App requests microphone access
3. Socket.io connects to signaling server
4. When users join the same room, WebRTC peer connections are established
5. **Hold the PTT button** → microphone tracks are enabled and audio streams peer-to-peer
6. **Release** → tracks are muted, transmission ends
7. Walkie-talkie beep sounds play on start/stop

## Browser Support

- ✅ Chrome 60+ (desktop & mobile)
- ✅ Safari 14+ (iOS & macOS)
- ✅ Firefox 60+
- ✅ Edge 79+

## License

MIT
