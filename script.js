'use strict';

/* ========== Configuración (ajusta aquí la sensación de manejo) ========== */
const CFG = {
  idle: 850,          // RPM en ralentí
  redline: 5800,      // Zona roja: alarma de cambio
  limit: 7000,        // Corte de combustible
  stallRpm: 400,      // Por debajo de esto, con el embrague soltado, se ahoga
  tachMax: 8000,
  speedMax: 220,
  finalDrive: 4.1,
  wheelRadius: 0.3,   // metros
  power: 7,           // aceleración máxima en 1.ª (m/s²)
  ratios: { '-1': 3.4, 1: 3.6, 2: 2.1, 3: 1.4, 4: 1.05, 5: 0.85 }
};
const REF_RATIO = CFG.ratios[1] * CFG.finalDrive;
const WHEEL_RPM_PER_MS = 60 / (2 * Math.PI * CFG.wheelRadius);
// Velocidad de movimiento de cada pedal por segundo: [al pisar, al soltar]
const PEDAL_RATES = { clutch: [5, 0.9], throttle: [4, 5], brake: [5, 6] };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, t, s) => (v < t ? Math.min(t, v + s) : Math.max(t, v - s));
const $ = (id) => document.getElementById(id);

/* ========== Estado ========== */
const car = {
  engine: 'off',   // 'off' | 'starting' | 'on'
  stalled: false,
  rpm: 0,
  v: 0,            // velocidad con signo (m/s)
  gear: 0,         // -1 = R, 0 = N, 1..5
  startT: 0,
  stallT: 0,
  pedal: { clutch: 0, throttle: 0, brake: 0 },
  input: { clutch: false, throttle: false, brake: false }
};
const msg = { text: '', t: 0 };
function setMsg(text, secs = 2.5) { msg.text = text; msg.t = secs; }

/* ========== Audio (Web Audio API) ========== */
const sound = {
  ctx: null,
  muted: false,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 2;
    this.filter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Tres osciladores: cuerpo (sierra), subgrave (cuadrada) y armónico (triangular)
    this.oscs = [['sawtooth', 1, 0.5], ['square', 0.5, 0.25], ['triangle', 2, 0.25]].map(([type, mult, vol]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      g.gain.value = vol;
      o.connect(g);
      g.connect(this.filter);
      o.start();
      return { o, mult };
    });

    // Buffer de ruido para el rechinido de engranes
    const len = Math.floor(ctx.sampleRate * 0.4);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  },

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  },

  // Sonido continuo del motor según RPM y acelerador
  update(rpm, throttle, running) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const freq = (rpm / 60) * 4;
    this.oscs.forEach(({ o, mult }) => o.frequency.setTargetAtTime(Math.max(5, freq * mult), t, 0.03));
    this.filter.frequency.setTargetAtTime(250 + rpm * 0.35 + throttle * 900, t, 0.05);
    const vol = running ? 0.1 + 0.18 * clamp(rpm / 7000, 0, 1) + 0.1 * throttle : 0;
    this.engineGain.gain.setTargetAtTime(vol, t, 0.05);
  },

  tone(f0, f1, dur, type, vol) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  },

  beep() { this.tone(1760, 1760, 0.12, 'square', 0.12); },       // alerta de zona roja
  start() { this.tone(70, 130, 0.9, 'sawtooth', 0.2); },          // motor de arranque
  stall() { this.tone(120, 35, 0.6, 'sawtooth', 0.3); },          // ahogamiento

  grind() {                                                       // rechinido de engranes
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const bp = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    src.buffer = this.noise;
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
  }
};
let lastBeep = 0;

/* ========== Acciones del conductor ========== */
function unlockAudio() { sound.init(); sound.resume(); }

function ignition() {
  unlockAudio();
  if (car.engine !== 'off') {
    car.engine = 'off';
    car.stalled = false;
    setMsg('Motor apagado.');
    return;
  }
  if (car.gear !== 0 && car.pedal.clutch < 0.7) {
    setMsg('Pisa el embrague o pon neutral para arrancar.');
    return;
  }
  car.engine = 'starting';
  car.startT = 0;
  car.stalled = false;
  car.stallT = 0;
  sound.start();
}

function setGear(g) {
  unlockAudio();
  if (g === car.gear) return;
  if (g !== 0 && car.pedal.clutch < 0.6 && Math.abs(car.v) > 0.5) {
    sound.grind();
    setMsg('¡Rechinan los engranes! Pisa el embrague antes de cambiar.');
    return;
  }
  car.gear = g;
}

function stall() {
  car.engine = 'off';
  car.stalled = true;
  car.stallT = 0;
  sound.stall();
  setMsg('¡Se ahogó el motor! Pisa el embrague y presiona E.', 4);
}

/* ========== Física ========== */
// Curva de torque: máxima a media vuelta del motor, cae en los extremos
const torque = (rpm) => 0.45 + 0.55 * Math.sin(Math.PI * clamp((rpm - 700) / 5600, 0, 1));

function step(dt) {
  const p = car.pedal;
  for (const k in p) {
    const [down, up] = PEDAL_RATES[k];
    p[k] = approach(p[k], car.input[k] ? 1 : 0, (car.input[k] ? down : up) * dt);
  }

  // Acople del embrague: 0 = pisado a fondo, 1 = totalmente suelto (punto de fricción entre 0.3 y 0.85)
  const coupling = clamp((0.85 - p.clutch) / 0.55, 0, 1);
  const ratio = car.gear === 0 ? 0 : CFG.ratios[car.gear];
  const k = (ratio * CFG.finalDrive) / REF_RATIO;
  const dir = car.gear < 0 ? -1 : 1;
  const driven = ratio ? car.v * dir * WHEEL_RPM_PER_MS * ratio * CFG.finalDrive : 0; // RPM impuestas por las ruedas
  let accel = 0;
  let resist = 0;

  if (car.engine === 'starting') {
    car.startT += dt;
    car.rpm = lerp(car.rpm, 260, 1 - Math.exp(-dt * 6));
    if (car.startT > 0.9) { car.engine = 'on'; car.rpm = 500; setMsg('Motor encendido.'); }
  } else if (car.engine === 'on') {
    const thr = car.rpm >= CFG.limit ? 0 : p.throttle; // limitador de RPM
    const target = CFG.idle + Math.pow(p.throttle, 1.2) * (CFG.limit - CFG.idle);
    const free = car.rpm + (target - car.rpm) * (1 - Math.exp(-dt * (target > car.rpm ? 4 : 2.5)));
    car.rpm = free;

    if (ratio && coupling > 0) {
      // Torque de arrastre (creep) que se desvanece al llegar al ralentí
      const creep = clamp((CFG.idle * 1.05 - driven) / 200, 0, 1) * 0.2;
      accel = dir * CFG.power * Math.max(thr, creep) * torque(car.rpm) * k * coupling;
      // Freno de motor al soltar el acelerador
      if (p.throttle < 0.1 && driven > CFG.idle) resist += 3 * (driven / 6000) * k * coupling;
      if (driven > CFG.limit) resist += (20 * (driven - CFG.limit)) / 1000 * coupling;

      // El motor se mezcla con las ruedas según cuánto embrague esté acoplado
      const floor = p.throttle > 0.2 ? 520 : 0;
      car.rpm = Math.min(lerp(free, Math.max(driven, floor), coupling), CFG.limit + 300);

      // Ahogamiento: embrague casi suelto y RPM demasiado bajas
      if (coupling > 0.8 && car.rpm < CFG.stallRpm) car.stallT += dt;
      else car.stallT = Math.max(0, car.stallT - dt * 2);
      if (car.stallT > 0.5) stall();
    } else {
      car.stallT = 0;
    }
  } else {
    car.rpm = approach(car.rpm, 0, 4000 * dt);
    if (ratio && coupling > 0 && driven > 0) resist += 2.5 * k * coupling; // compresión con motor apagado
  }

  car.v += accel * dt;
  const s = Math.abs(car.v);
  resist += 0.15 + 0.00057 * s * s + p.brake * 9; // rodadura + aire + freno
  car.v = Math.sign(car.v) * Math.max(0, s - resist * dt);
}

/* ========== Interfaz ========== */
const NS = 'http://www.w3.org/2000/svg';
const ui = {
  tach: $('tachNeedle'), speed: $('speedNeedle'),
  rpm: $('rpmOut'), kmh: $('speedOut'), gear: $('gearOut'),
  shift: $('shiftLight'), hint: $('hint'), state: $('engineState'),
  pedals: document.querySelectorAll('[data-pedal]'),
  gearBtns: document.querySelectorAll('[data-gear]')
};

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
}
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const key in attrs) e.setAttribute(key, attrs[key]);
  parent.appendChild(e);
  return e;
}
function buildDial(g, { max, major, minor, div, redFrom }) {
  const ang = (v) => -135 + (v / max) * 270;
  if (redFrom != null) {
    const a = polar(80, ang(redFrom));
    const b = polar(80, ang(max));
    svgEl('path', { d: `M${a[0]} ${a[1]} A80 80 0 0 1 ${b[0]} ${b[1]}`, class: 'redzone' }, g);
  }
  for (let v = 0; v <= max; v += minor) {
    const isMajor = v % major === 0;
    const [x1, y1] = polar(isMajor ? 68 : 74, ang(v));
    const [x2, y2] = polar(84, ang(v));
    svgEl('line', { x1, y1, x2, y2, class: isMajor ? 'tick major' : 'tick' }, g);
    if (isMajor) {
      const [tx, ty] = polar(56, ang(v));
      svgEl('text', { x: tx, y: ty, class: 'label' }, g).textContent = v / div;
    }
  }
}
buildDial($('tachDial'), { max: CFG.tachMax, major: 1000, minor: 500, div: 1000, redFrom: CFG.redline });
buildDial($('speedDial'), { max: CFG.speedMax, major: 20, minor: 10, div: 1 });

const setNeedle = (el, f) =>
  el.setAttribute('transform', `translate(100 100) rotate(${-135 + clamp(f, 0, 1.02) * 270})`);

function autoHint() {
  if (car.engine === 'off') return car.stalled ? 'Motor ahogado. Pisa el embrague y presiona E.' : 'Presiona E para arrancar el motor.';
  if (car.engine === 'starting') return 'Arrancando…';
  if (car.rpm > CFG.redline) return car.gear < 5 ? '¡Sube de marcha!' : 'Zona roja: suelta el acelerador.';
  if (car.gear === 0) return 'Neutral. Pisa el embrague y elige una marcha.';
  if (car.pedal.clutch < 0.3 && car.rpm < 1300 && car.gear > 1 && car.pedal.throttle > 0.5) return 'Motor forzado: baja de marcha.';
  return 'Listo para conducir.';
}

const STATE_TEXT = { off: 'Motor apagado', starting: 'Arrancando', on: 'Motor encendido', stalled: 'Motor ahogado' };

function render(dt) {
  const kmh = Math.abs(car.v) * 3.6;
  setNeedle(ui.tach, car.rpm / CFG.tachMax);
  setNeedle(ui.speed, kmh / CFG.speedMax);
  ui.rpm.textContent = Math.round(car.rpm / 10) * 10;
  ui.kmh.textContent = Math.round(kmh);
  ui.gear.textContent = car.gear === 0 ? 'N' : car.gear < 0 ? 'R' : car.gear;

  const inRed = car.engine === 'on' && car.rpm > CFG.redline;
  ui.shift.classList.toggle('on', inRed);

  msg.t -= dt;
  ui.hint.textContent = msg.t > 0 ? msg.text : autoHint();

  const st = car.engine === 'off' && car.stalled ? 'stalled' : car.engine;
  ui.state.dataset.state = st;
  ui.state.textContent = STATE_TEXT[st];

  ui.pedals.forEach((b) => b.style.setProperty('--level', car.pedal[b.dataset.pedal].toFixed(3)));
  ui.gearBtns.forEach((b) => b.classList.toggle('active', Number(b.dataset.gear) === car.gear));
}

/* ========== Entradas ========== */
const KEY_PEDAL = { Space: 'clutch', ArrowUp: 'throttle', ArrowDown: 'brake' };
const KEY_GEAR = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Numpad1: 1, Numpad2: 2, Numpad3: 3,
  Numpad4: 4, Numpad5: 5, KeyN: 0, Digit0: 0, Numpad0: 0, KeyR: -1 };

window.addEventListener('keydown', (e) => {
  const pedal = KEY_PEDAL[e.code];
  if (pedal) { e.preventDefault(); unlockAudio(); car.input[pedal] = true; return; }
  if (e.repeat) return;
  if (e.code === 'KeyE') ignition();
  else if (e.code in KEY_GEAR) setGear(KEY_GEAR[e.code]);
});
window.addEventListener('keyup', (e) => {
  const pedal = KEY_PEDAL[e.code];
  if (pedal) { e.preventDefault(); car.input[pedal] = false; }
});
window.addEventListener('blur', () => { for (const k in car.input) car.input[k] = false; });

ui.pedals.forEach((btn) => {
  const name = btn.dataset.pedal;
  const release = () => { car.input[name] = false; };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    unlockAudio();
    btn.setPointerCapture(e.pointerId);
    car.input[name] = true;
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, release));
});
ui.gearBtns.forEach((btn) => btn.addEventListener('click', () => setGear(Number(btn.dataset.gear))));
$('ignitionBtn').addEventListener('click', ignition);
$('muteBtn').addEventListener('click', (e) => {
  unlockAudio();
  sound.setMuted(!sound.muted);
  e.currentTarget.setAttribute('aria-pressed', String(sound.muted));
  e.currentTarget.textContent = sound.muted ? 'Sonido: no' : 'Sonido: sí';
});

/* ========== Bucle principal ========== */
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  step(dt);

  const running = car.engine !== 'off' || car.rpm > 50;
  sound.update(car.rpm, car.pedal.throttle, running);

  // Pitido repetido mientras el motor esté en zona roja
  if (car.engine === 'on' && car.rpm > CFG.redline && now - lastBeep > 320) {
    sound.beep();
    lastBeep = now;
  }

  render(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
