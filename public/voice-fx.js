// ============================================
// Voice Effects Engine v2 — Web Audio API
// Real-time voice processing for WebRTC
// ============================================
window.VoiceFX = (function () {
  'use strict';

  var audioCtx = null;
  var sourceNode = null;
  var gainNode = null;
  var outputNode = null;
  var currentEffect = 'none';
  var effectNodes = [];
  var processedStream = null;
  var micStream = null;

  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function cleanup() {
    effectNodes.forEach(function (n) {
      try { n.disconnect(); } catch (e) { /* ok */ }
      try { if (n.stop) n.stop(); } catch (e) { /* ok */ }
    });
    effectNodes = [];
  }

  function init(inputStream) {
    var ctx = getCtx();
    micStream = inputStream;
    var dest = ctx.createMediaStreamDestination();
    sourceNode = ctx.createMediaStreamSource(inputStream);
    gainNode = ctx.createGain();
    gainNode.gain.value = 1.0;
    outputNode = dest;
    sourceNode.connect(gainNode);
    gainNode.connect(dest);
    processedStream = dest.stream;
    return processedStream;
  }

  function setEffect(name) {
    if (!sourceNode || !gainNode || !outputNode) return;
    var ctx = getCtx();
    cleanup();
    try { sourceNode.disconnect(); } catch (e) { /* ok */ }
    try { gainNode.disconnect(); } catch (e) { /* ok */ }
    currentEffect = name;

    switch (name) {
      case 'none':
        sourceNode.connect(gainNode);
        gainNode.connect(outputNode);
        break;

      case 'deep':
        // Deep man: low shelf boost + high cut
        applyDeep(ctx);
        break;

      case 'lady':
        // Lady: slight high boost
        applyLady(ctx);
        break;

      case 'girl':
        // Girl: more high boost
        applyGirl(ctx);
        break;

      case 'boy':
        // Boy: moderate high boost
        applyBoy(ctx);
        break;

      case 'child':
        // Child: strong high boost
        applyChild(ctx);
        break;

      case 'oldman':
        // Old man: low + tremolo
        applyOldMan(ctx);
        break;

      case 'robot':
        // Robot: ring modulation
        applyRobot(ctx);
        break;

      case 'alien':
        // Alien: ring mod + echo
        applyAlien(ctx);
        break;

      case 'chipmunk':
        // Chipmunk: very high boost
        applyChipmunk(ctx);
        break;

      case 'monster':
        // Monster: low + distortion
        applyMonster(ctx);
        break;

      case 'echo':
        // Echo/delay
        applyEcho(ctx);
        break;

      case 'whisper':
        // Whisper: bandpass + breathiness
        applyWhisper(ctx);
        break;

      case 'megaphone':
        // Megaphone: compression + distortion
        applyMegaphone(ctx);
        break;

      default:
        sourceNode.connect(gainNode);
        gainNode.connect(outputNode);
    }
  }

  // --- Effect Implementations ---

  function applyDeep(ctx) {
    var low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 600;
    low.gain.value = 12;
    var high = ctx.createBiquadFilter();
    high.type = 'lowpass';
    high.frequency.value = 2500;
    high.Q.value = 0.5;
    sourceNode.connect(high);
    high.connect(low);
    low.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(low, high);
  }

  function applyLady(ctx) {
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 200;
    hp.Q.value = 0.7;
    var hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 2500;
    hs.gain.value = 6;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;
    sourceNode.connect(hp);
    hp.connect(hs);
    hs.connect(lp);
    lp.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(hp, hs, lp);
  }

  function applyGirl(ctx) {
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.8;
    var hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 3000;
    hs.gain.value = 10;
    sourceNode.connect(hp);
    hp.connect(hs);
    hs.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(hp, hs);
  }

  function applyBoy(ctx) {
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 250;
    var hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 2000;
    hs.gain.value = 5;
    sourceNode.connect(hp);
    hp.connect(hs);
    hs.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(hp, hs);
  }

  function applyChild(ctx) {
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    hp.Q.value = 0.9;
    var hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 4000;
    hs.gain.value = 14;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    sourceNode.connect(hp);
    hp.connect(hs);
    hs.connect(lp);
    lp.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(hp, hs, lp);
  }

  function applyOldMan(ctx) {
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    lp.Q.value = 0.5;
    var ls = ctx.createBiquadFilter();
    ls.type = 'lowshelf';
    ls.frequency.value = 500;
    ls.gain.value = 8;
    // Tremolo (shaky voice)
    var tremGain = ctx.createGain();
    var lfo = ctx.createOscillator();
    var lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 6;
    lfo.start();
    lfoGain.gain.value = 0.4;
    lfo.connect(lfoGain);
    lfoGain.connect(tremGain.gain);
    tremGain.gain.value = 1.0;
    sourceNode.connect(lp);
    lp.connect(ls);
    ls.connect(tremGain);
    tremGain.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(lp, ls, tremGain, lfo, lfoGain);
  }

  function applyRobot(ctx) {
    var osc = ctx.createOscillator();
    var ringGain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 50;
    osc.start();
    ringGain.gain.value = 0;
    osc.connect(ringGain.gain);
    var mix = ctx.createGain();
    mix.gain.value = 0.15;
    sourceNode.connect(mix);
    mix.connect(gainNode);
    sourceNode.connect(ringGain);
    ringGain.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(osc, ringGain, mix);
  }

  function applyAlien(ctx) {
    var osc = ctx.createOscillator();
    var ringGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 150;
    osc.start();
    ringGain.gain.value = 0;
    osc.connect(ringGain.gain);
    var delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.04;
    var fb = ctx.createGain();
    fb.gain.value = 0.5;
    sourceNode.connect(ringGain);
    ringGain.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(osc, ringGain, delay, fb);
  }

  function applyChipmunk(ctx) {
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 500;
    hp.Q.value = 1.0;
    var hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 5000;
    hs.gain.value = 18;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 8000;
    sourceNode.connect(hp);
    hp.connect(hs);
    hs.connect(lp);
    lp.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(hp, hs, lp);
  }

  function applyMonster(ctx) {
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    var ls = ctx.createBiquadFilter();
    ls.type = 'lowshelf';
    ls.frequency.value = 400;
    ls.gain.value = 15;
    var ws = ctx.createWaveShaper();
    var curve = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var x = (i * 2) / 256 - 1;
      curve[i] = ((Math.PI + 30) * x) / (Math.PI + 30 * Math.abs(x));
    }
    ws.curve = curve;
    ws.oversample = '4x';
    sourceNode.connect(lp);
    lp.connect(ls);
    ls.connect(ws);
    ws.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(lp, ls, ws);
  }

  function applyEcho(ctx) {
    var delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.2;
    var fb = ctx.createGain();
    fb.gain.value = 0.5;
    var dry = ctx.createGain();
    dry.gain.value = 0.7;
    var wet = ctx.createGain();
    wet.gain.value = 0.6;
    sourceNode.connect(dry);
    sourceNode.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    dry.connect(gainNode);
    wet.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(delay, fb, dry, wet);
  }

  function applyWhisper(ctx) {
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000;
    bp.Q.value = 0.3;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1000;
    hp.Q.value = 0.5;
    var noise = ctx.createOscillator();
    noise.type = 'sawtooth';
    noise.frequency.value = 3000;
    var noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.08;
    noise.start();
    noise.connect(noiseGain);
    sourceNode.connect(bp);
    bp.connect(hp);
    hp.connect(gainNode);
    noiseGain.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(bp, hp, noise, noiseGain);
  }

  function applyMegaphone(ctx) {
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1.0;
    var ws = ctx.createWaveShaper();
    var curve = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var x = (i * 2) / 256 - 1;
      curve[i] = Math.sign(x) * Math.pow(Math.abs(x), 0.5);
    }
    ws.curve = curve;
    sourceNode.connect(bp);
    bp.connect(ws);
    ws.connect(gainNode);
    gainNode.connect(outputNode);
    effectNodes.push(bp, ws);
  }

  function getProcessedStream() { return processedStream; }
  function getCurrentEffect() { return currentEffect; }
  function getMicStream() { return micStream; }

  function destroy() {
    cleanup();
    if (sourceNode) try { sourceNode.disconnect(); } catch (e) { /* ok */ }
    if (gainNode) try { gainNode.disconnect(); } catch (e) { /* ok */ }
    if (processedStream) processedStream.getTracks().forEach(function (t) { t.stop(); });
    sourceNode = null; gainNode = null; outputNode = null; processedStream = null; micStream = null;
  }

  return {
    init: init,
    setEffect: setEffect,
    getProcessedStream: getProcessedStream,
    getCurrentEffect: getCurrentEffect,
    getMicStream: getMicStream,
    destroy: destroy
  };
})();
