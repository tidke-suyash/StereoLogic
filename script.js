/* ═══════════════════════════════════════════════════════════
   STEREO LOGIC — Mobile-First RGB Audio Engine
   PWA-ready · No canvas visualizer · Battery-friendly
═══════════════════════════════════════════════════════════ */

const root  = document.documentElement;
const audio = document.getElementById('engine');
const rig   = document.getElementById('speaker-rig');
const deck  = document.getElementById('main-deck');

// ── EQ CONFIG ──────────────────────────────────────────────
const EQ_FREQS  = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ['31','62','125','250','500','1k','2k','4k','8k','16k'];
const PRESETS = {
    flat:   [0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
    bass:   [8,  6,  4,  1,  0, -1,  0,  1,  2,  3],
    edm:    [7,  6,  2,  0, -2,  0,  2,  4,  5,  5],
    rock:   [5,  4,  2, -1, -2,  0,  2,  3,  4,  4],
    vocal:  [-2,-1,  0,  2,  5,  6,  4,  2,  0, -1],
    cinema: [6,  5,  3,  1,  0,  1,  2,  4,  5,  6],
    phonk:  [10, 8,  4,  0, -3, -1,  1,  3,  5,  6],
};

// ── APP STATE ──────────────────────────────────────────────
let state = {
    queue: [], curIdx: -1, shuf: false, rep: 0, shufOrder: [],
    vol: 0.8, spd: 1, eq: [...PRESETS.flat],
    rgbMode: 'stereo',
};

// ── AUDIO NODES ────────────────────────────────────────────
let audioCtx, srcNode, gainNode, eqNodes = [];
let splitter, anaL, anaR, dataL, dataR;
let inited = false, dbAvailable = false;

// ── ANIMATION STATE ────────────────────────────────────────
let smSubL = 0, smSubR = 0, smBass = 0;
let hueBase = 180, targetPower = 0, currentPower = 0;
let orbitAngleL = 0, orbitAngleR = 0;

// ── INDEXED DB ─────────────────────────────────────────────
const AudioDB = {
    db: null,
    init() {
        return new Promise((resolve) => {
            try {
                const req = indexedDB.open('StereoLogic_CoreDB', 4);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (db.objectStoreNames.contains('tracks')) db.deleteObjectStore('tracks');
                    db.createObjectStore('tracks', { keyPath: 'id' });
                };
                req.onsuccess = (e) => { this.db = e.target.result; resolve(true); };
                req.onerror  = () => resolve(false);
            } catch (e) { resolve(false); }
        });
    },
    addTrack(t) {
        return new Promise(r => {
            if (!this.db) return r();
            try {
                const tx = this.db.transaction('tracks', 'readwrite');
                tx.objectStore('tracks').put(t);
                tx.oncomplete = r; tx.onerror = r;
            } catch (e) { r(); }
        });
    },
    deleteTrack(id) {
        return new Promise(r => {
            if (!this.db) return r();
            try {
                const tx = this.db.transaction('tracks', 'readwrite');
                tx.objectStore('tracks').delete(id);
                tx.oncomplete = r;
            } catch (e) { r(); }
        });
    },
    clear() {
        return new Promise(r => {
            if (!this.db) return r();
            try {
                const tx = this.db.transaction('tracks', 'readwrite');
                tx.objectStore('tracks').clear();
                tx.oncomplete = r;
            } catch (e) { r(); }
        });
    },
    getAll() {
        return new Promise(r => {
            if (!this.db) return r([]);
            try {
                const tx  = this.db.transaction('tracks', 'readonly');
                const req = tx.objectStore('tracks').getAll();
                req.onsuccess = () => r(req.result);
                req.onerror   = () => r([]);
            } catch (e) { r([]); }
        });
    },
};

// ── SETTINGS STORAGE ───────────────────────────────────────
const Storage = {
    KEY: 'sl_settings_v10',
    save() {
        try {
            localStorage.setItem(this.KEY, JSON.stringify({
                vol: state.vol, spd: state.spd, eq: state.eq,
                rgbMode: state.rgbMode,
                shuf: state.shuf, rep: state.rep,
                savedOrder: state.queue.map(q => q.id),
                lastIdx: state.curIdx,
                lastTime: audio.currentTime || 0,
            }));
        } catch (e) {}
    },
    load() {
        try {
            const d = JSON.parse(localStorage.getItem(this.KEY));
            if (d) {
                state.vol     = d.vol     ?? 0.8;
                state.spd     = d.spd     ?? 1;
                state.eq      = d.eq      || [...PRESETS.flat];
                state.rgbMode = d.rgbMode || 'stereo';
                state.shuf    = !!d.shuf;
                state.rep     = d.rep     || 0;
                return d;
            }
        } catch (e) {}
        return null;
    },
};

// Unlock AudioContext on user gesture (Safari / Brave)
document.body.addEventListener('click',      unlockCtx, true);
document.body.addEventListener('touchstart', unlockCtx, true);
function unlockCtx() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// ═══════════════════════════════════════════════════════════
//  SERVICE WORKER REGISTRATION
// ═══════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => {
            console.warn('SW registration failed:', err);
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  BOOT & ENGINE INIT
// ═══════════════════════════════════════════════════════════
window.boot = async function () {
    if (inited) return;

    // Silent token to unlock autoplay policy before attaching real src
    try {
        audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        await audio.play();
        audio.pause();
        audio.src = '';
        audio.load();
    } catch (e) {}

    document.getElementById('start-btn').textContent = 'CONNECTING…';

    dbAvailable = await AudioDB.init();
    const memory = Storage.load();

    // ── Restore queue from IndexedDB ──────────────────────
    if (dbAvailable) {
        const stored  = await AudioDB.getAll();
        const trackMap = {};
        stored.forEach(t => {
            if (t.buffer) {
                try {
                    const blob = new Blob([t.buffer], { type: t.mime || 'audio/mpeg' });
                    t.url = URL.createObjectURL(blob);
                } catch (e) { return; }
            }
            if (t.artBlob) t.art = URL.createObjectURL(t.artBlob);
            trackMap[t.id] = t;
        });
        if (memory?.savedOrder) {
            memory.savedOrder.forEach(id => {
                if (trackMap[id]) { state.queue.push(trackMap[id]); delete trackMap[id]; }
            });
        }
        Object.values(trackMap).forEach(t => state.queue.push(t));
        state.curIdx = (memory?.lastIdx !== undefined && memory.lastIdx < state.queue.length)
            ? memory.lastIdx
            : (state.queue.length > 0 ? 0 : -1);
    }

    // ── Build Audio Graph ─────────────────────────────────
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
        srcNode  = audioCtx.createMediaElementSource(audio);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = state.vol;
        srcNode.connect(gainNode);

        // 10-band EQ chain
        let chain = gainNode;
        EQ_FREQS.forEach((freq, i) => {
            const f = audioCtx.createBiquadFilter();
            f.type            = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
            f.frequency.value = freq;
            f.gain.value      = state.eq[i];
            f.Q.value         = 1.4;
            chain.connect(f);
            chain = f;
            eqNodes.push(f);
        });

        // Stereo splitter for L/R analysis
        splitter = audioCtx.createChannelSplitter(2);
        chain.connect(splitter);

        anaL = audioCtx.createAnalyser(); anaL.fftSize = 1024; anaL.smoothingTimeConstant = 0.82;
        anaR = audioCtx.createAnalyser(); anaR.fftSize = 1024; anaR.smoothingTimeConstant = 0.82;
        splitter.connect(anaL, 0);
        splitter.connect(anaR, 1);

        // Audio must reach destination
        chain.connect(audioCtx.destination);

        dataL = new Uint8Array(anaL.frequencyBinCount);
        dataR = new Uint8Array(anaR.frequencyBinCount);
    } catch (e) {
        console.error('Audio init failed:', e);
        alert('Audio engine failed. If using Brave, disable Shields for this page.');
        return;
    }

    // ── Restore UI state ──────────────────────────────────
    document.getElementById('vol').value               = state.vol;
    document.getElementById('spd-slider').value        = state.spd;
    document.getElementById('spd-val').textContent     = state.spd.toFixed(1) + '×';
    document.getElementById('sel-rgb').value           = state.rgbMode;
    if (state.shuf) document.getElementById('shuf-btn').classList.add('on');
    updateRepIcon();
    buildEQUI();

    inited = true;
    refreshPL();

    if (state.queue.length > 0 && state.curIdx > -1) {
        audio.src          = state.queue[state.curIdx].url;
        audio.playbackRate = state.spd;
        updateNowPlaying();
        audio.addEventListener('loadedmetadata', function onMeta() {
            if (memory?.lastTime) audio.currentTime = memory.lastTime;
            audio.removeEventListener('loadedmetadata', onMeta);
        });
    }

    // ── Transition boot → app ─────────────────────────────
    const bootEl = document.getElementById('boot');
    bootEl.style.opacity = '0';
    setTimeout(() => {
        bootEl.remove();
        document.getElementById('app').classList.remove('hidden');
        renderLoop();
    }, 850);

    applyPhysics(false);
};

// ═══════════════════════════════════════════════════════════
//  PHYSICS
// ═══════════════════════════════════════════════════════════
function applyPhysics(isPlaying) {
    if (isPlaying) {
        rig.classList.replace('power-down', 'power-up')   || rig.classList.add('power-up');
        deck.classList.replace('power-down', 'power-up')  || deck.classList.add('power-up');
        targetPower = 1;
    } else {
        rig.classList.replace('power-up', 'power-down')   || rig.classList.add('power-down');
        deck.classList.replace('power-up', 'power-down')  || deck.classList.add('power-down');
        targetPower = 0;
    }
}

// ═══════════════════════════════════════════════════════════
//  AUDIO CONTROLS
// ═══════════════════════════════════════════════════════════
window.togglePlay = function () {
    if (!inited) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    if (!audio.src && state.queue.length) {
        return playIdx(state.curIdx > -1 ? state.curIdx : 0);
    }
    if (!audio.src) return;
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
};

window.playIdx = function (i) {
    if (i < 0 || i >= state.queue.length) return;
    state.curIdx = i;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    audio.src          = state.queue[i].url;
    audio.playbackRate = state.spd;
    audio.play().catch(e => {
        console.warn('Playback blocked:', e);
        applyPhysics(false);
    });
    updateNowPlaying();
    refreshPL();
    Storage.save();
};

window.nextTrack = function () {
    if (!state.queue.length) return;
    if (state.rep === 2) { audio.currentTime = 0; audio.play(); return; }
    const next = state.shuf
        ? state.shufOrder[(state.shufOrder.indexOf(state.curIdx) + 1) % state.queue.length]
        : (state.curIdx + 1) % state.queue.length;
    playIdx(next);
};

window.prevTrack = function () {
    if (!state.queue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    playIdx((state.curIdx - 1 + state.queue.length) % state.queue.length);
};

window.toggleShuffle = function () {
    state.shuf = !state.shuf;
    document.getElementById('shuf-btn').classList.toggle('on', state.shuf);
    if (state.shuf) state.shufOrder = [...Array(state.queue.length).keys()].sort(() => Math.random() - 0.5);
    Storage.save();
};

window.toggleRepeat = function () {
    state.rep = (state.rep + 1) % 3;
    updateRepIcon();
    Storage.save();
};

function updateRepIcon() {
    document.getElementById('rep-btn').classList.toggle('on', state.rep > 0);
    const paths = [
        'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
        'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zM11 17v-6l-2 2.06-.73-.73L11 10h2v7h-2z',
    ];
    document.getElementById('rep-icon').querySelector('path').setAttribute('d', paths[state.rep === 1 ? 1 : 0]);
}

// ── Audio element events ───────────────────────────────────
audio.addEventListener('play', () => {
    document.getElementById('play-btn').classList.add('playing');
    document.getElementById('play-path').setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    document.getElementById('art-wrap').classList.add('playing');
    applyPhysics(true);
});

audio.addEventListener('pause', () => {
    document.getElementById('play-btn').classList.remove('playing');
    document.getElementById('play-path').setAttribute('d', 'M8 5v14l11-7z');
    document.getElementById('art-wrap').classList.remove('playing');
    applyPhysics(false);
    Storage.save();
});

audio.addEventListener('ended',  nextTrack);
audio.addEventListener('error',  () => setTimeout(nextTrack, 1200));

audio.addEventListener('timeupdate', () => {
    const cur = audio.currentTime;
    const dur = audio.duration || 0;
    document.getElementById('t-cur').textContent = fmt(cur);
    document.getElementById('t-tot').textContent = fmt(dur);
    if (dur) document.getElementById('pbar').style.width = `${(cur / dur) * 100}%`;
});

audio.addEventListener('loadedmetadata', () => {
    const sampleRate = audioCtx?.sampleRate;
    document.getElementById('badge-hz').textContent = sampleRate ? `${(sampleRate / 1000).toFixed(1)}kHz` : '—';
});

// Periodic save every 5s during playback
setInterval(() => { if (!audio.paused && inited) Storage.save(); }, 5000);

// ── UI Events ──────────────────────────────────────────────
document.getElementById('prog-track').addEventListener('click', e => {
    if (!audio.duration) return;
    const rect  = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
    Storage.save();
});

// Touch scrubbing on progress bar
(function () {
    const pt = document.getElementById('prog-track');
    let scrubbing = false;
    const scrub = (clientX) => {
        if (!audio.duration) return;
        const rect  = pt.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        audio.currentTime = ratio * audio.duration;
    };
    pt.addEventListener('touchstart', e => { scrubbing = true; scrub(e.touches[0].clientX); }, { passive: true });
    pt.addEventListener('touchmove',  e => { if (scrubbing) scrub(e.touches[0].clientX); }, { passive: true });
    pt.addEventListener('touchend',   () => { scrubbing = false; Storage.save(); });
})();

document.getElementById('vol').addEventListener('input', e => {
    state.vol = parseFloat(e.target.value);
    if (gainNode) gainNode.gain.setTargetAtTime(state.vol, audioCtx.currentTime, 0.05);
    Storage.save();
});

document.getElementById('spd-slider').addEventListener('input', e => {
    state.spd = parseFloat(e.target.value);
    audio.playbackRate = state.spd;
    document.getElementById('spd-val').textContent = state.spd.toFixed(1) + '×';
    Storage.save();
});

document.getElementById('sel-rgb').addEventListener('change', e => {
    state.rgbMode = e.target.value;
    Storage.save();
});

// ── File input listeners ───────────────────────────────────
document.getElementById('file-in').addEventListener('change',  e => { handleFiles(e.target.files); e.target.value = ''; });
document.getElementById('file-in2').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

// ═══════════════════════════════════════════════════════════
//  FILE HANDLING
// ═══════════════════════════════════════════════════════════
window.handleFiles = function (files) {
    if (!inited) { alert('Please Initialize Engine first!'); return; }
    const arr = Array.from(files).filter(f =>
        f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|aac|m4a|opus|weba)$/i.test(f.name)
    );
    if (!arr.length) return;

    if (audioCtx?.state === 'suspended') audioCtx.resume();
    const startIndex = state.queue.length;
    const wasEmpty   = state.curIdx === -1;

    arr.forEach(file => {
        const ext = file.name.split('.').pop()?.toUpperCase() || 'AUDIO';
        state.queue.push({
            id:      Date.now() + Math.random(),
            file,
            url:     URL.createObjectURL(file),
            title:   file.name.replace(/\.[^/.]+$/, ''),
            artist:  'Unknown Artist',
            fmt:     ext,
            artBlob: null,
            art:     null,
        });
    });

    if (wasEmpty) {
        state.curIdx       = startIndex;
        audio.src          = state.queue[startIndex].url;
        audio.playbackRate = state.spd;
        audio.play().catch(() => {});
        updateNowPlaying();
    }

    refreshPL();
    Storage.save();

    // Read ID3 tags asynchronously
    arr.forEach((file, rel) => {
        const idx  = startIndex + rel;
        const item = state.queue[idx];
        if (window.jsmediatags) {
            jsmediatags.read(file, {
                onSuccess: tag => {
                    const t = tag.tags;
                    let changed = false;
                    if (t.title)  { item.title  = t.title;  changed = true; }
                    if (t.artist) { item.artist = t.artist; changed = true; }
                    if (t.picture) {
                        try {
                            const blob = new Blob([new Uint8Array(t.picture.data)], { type: t.picture.format });
                            item.artBlob = blob;
                            item.art     = URL.createObjectURL(blob);
                            changed = true;
                        } catch (e) {}
                    }
                    if (changed) {
                        if (state.curIdx === idx) updateNowPlaying();
                        refreshPL();
                    }
                    saveToDB(file, item);
                },
                onError: () => saveToDB(file, item),
            });
        } else {
            saveToDB(file, item);
        }
    });
};

function saveToDB(file, item) {
    if (!dbAvailable) return;
    try {
        file.arrayBuffer().then(buffer => {
            AudioDB.addTrack({
                id: item.id, buffer, mime: file.type || 'audio/mpeg',
                title: item.title, artist: item.artist, artBlob: item.artBlob,
            });
        }).catch(() => {});
    } catch (e) {}
}

// ── Queue Management ───────────────────────────────────────
window.clearQueue = async function () {
    state.queue.forEach(q => {
        if (q.url) URL.revokeObjectURL(q.url);
        if (q.art) URL.revokeObjectURL(q.art);
    });
    state.queue  = [];
    state.curIdx = -1;
    audio.pause();
    audio.src = '';
    if (dbAvailable) await AudioDB.clear();
    refreshPL();
    updateNowPlaying();
    Storage.save();
    applyPhysics(false);
};

window.factoryReset = async function () {
    localStorage.removeItem(Storage.KEY);
    if (dbAvailable) await AudioDB.clear();
    location.reload();
};

function sanitize(str) {
    return String(str).replace(/[&<>'"]/g, m =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[m])
    );
}

function refreshPL() {
    const list = document.getElementById('pl-list');
    list.innerHTML = '';

    state.queue.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `pl-item${i === state.curIdx ? ' now' : ''}`;
        const thumb = item.art
            ? `<img src="${item.art}" alt="" loading="lazy">`
            : '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22%3E%3Crect width=%221%22 height=%221%22 fill=%22%23080812%22/%3E%3C/svg%3E" alt="">';

        div.innerHTML = `
            <div class="pl-thumb">${thumb}</div>
            <div class="pl-meta">
                <div class="pl-name">${sanitize(item.title)}</div>
                <div class="pl-artist">${sanitize(item.artist)}</div>
            </div>
            <button class="pl-rm" title="Remove" aria-label="Remove track">✕</button>`;

        div.addEventListener('click', e => { if (!e.target.classList.contains('pl-rm')) playIdx(i); });
        div.querySelector('.pl-rm').addEventListener('click', async e => {
            e.stopPropagation();
            if (item.url) URL.revokeObjectURL(item.url);
            if (item.art) URL.revokeObjectURL(item.art);
            if (dbAvailable) await AudioDB.deleteTrack(item.id);
            state.queue.splice(i, 1);
            if (i === state.curIdx) {
                audio.pause(); audio.src = ''; state.curIdx = -1;
                if (state.queue.length) playIdx(Math.max(0, i - 1));
                else updateNowPlaying();
            } else if (i < state.curIdx) {
                state.curIdx--;
            }
            refreshPL();
            Storage.save();
        });

        list.appendChild(div);
    });

    document.getElementById('pl-counter').textContent =
        state.queue.length ? `${state.curIdx + 1}/${state.queue.length}` : '0/0';
}

function updateNowPlaying() {
    const fallbackArt = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' fill='%230a0a16'/%3E%3Ccircle cx='40' cy='40' r='18' fill='none' stroke='%23222233' stroke-width='1.5'/%3E%3Ccircle cx='40' cy='40' r='5' fill='%23222233'/%3E%3C/svg%3E";

    if (state.curIdx === -1 || !state.queue.length) {
        document.getElementById('track-title').textContent  = 'NO SIGNAL';
        document.getElementById('track-artist').textContent = 'Awaiting Input';
        document.getElementById('cover-art').src            = fallbackArt;
        document.getElementById('badge-fmt').textContent    = '—';
        document.getElementById('badge-hz').textContent     = '—';
        return;
    }

    const item = state.queue[state.curIdx];
    document.getElementById('track-title').textContent  = item.title  || 'Unknown Track';
    document.getElementById('track-artist').textContent = item.artist || 'Unknown Artist';
    document.getElementById('cover-art').src            = item.art    || fallbackArt;
    document.getElementById('badge-fmt').textContent    = item.fmt    || '—';
}

// ═══════════════════════════════════════════════════════════
//  EQ UI
// ═══════════════════════════════════════════════════════════
function buildEQUI() {
    const wrap = document.getElementById('eq-bands');
    wrap.innerHTML = '';
    EQ_FREQS.forEach((_, i) => {
        const div = document.createElement('div');
        div.className = 'eq-band';
        div.innerHTML = `
            <div class="eq-val" id="eqv-${i}">${fmtDB(state.eq[i])}</div>
            <div class="eq-slider-host">
                <input class="eqr" type="range" min="-12" max="12" step="0.5"
                       value="${state.eq[i]}" oninput="setEQ(${i}, this.value)">
            </div>
            <div class="eq-band-lbl">${EQ_LABELS[i]}</div>`;
        wrap.appendChild(div);
    });
}

function fmtDB(v) { return v > 0 ? `+${v}` : `${v}`; }

window.setEQ = (i, val) => {
    val = parseFloat(val);
    state.eq[i] = val;
    if (eqNodes[i] && audioCtx) eqNodes[i].gain.setTargetAtTime(val, audioCtx.currentTime, 0.05);
    document.getElementById(`eqv-${i}`).textContent = fmtDB(val);
    document.querySelectorAll('.prbtn').forEach(b => b.classList.remove('on'));
    drawEQCurve();
    Storage.save();
};

document.querySelectorAll('.prbtn[data-preset]').forEach(btn => {
    btn.addEventListener('click', e => {
        const p = PRESETS[e.target.dataset.preset];
        p.forEach((v, i) => {
            state.eq[i] = v;
            if (eqNodes[i] && audioCtx) eqNodes[i].gain.setTargetAtTime(v, audioCtx.currentTime, 0.05);
            const slider = document.querySelectorAll('.eqr')[i];
            if (slider) slider.value = v;
            const valEl = document.getElementById(`eqv-${i}`);
            if (valEl) valEl.textContent = fmtDB(v);
        });
        document.querySelectorAll('.prbtn').forEach(b => b.classList.remove('on'));
        e.target.classList.add('on');
        drawEQCurve();
        Storage.save();
    });
});

window.resetEQ = () => document.querySelector('.prbtn[data-preset="flat"]').click();

function drawEQCurve() {
    const cv = document.getElementById('eq-curve');
    if (!cv) return;
    const w = cv.width = cv.offsetWidth || 300;
    const h = cv.height = 48;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const step = w / (EQ_FREQS.length - 1);
    const midY = h / 2;
    const getY = idx => midY - (state.eq[idx] / 12) * (midY - 5);

    ctx.beginPath();
    ctx.moveTo(0, getY(0));
    for (let i = 1; i < EQ_FREQS.length; i++) {
        const x = i * step, px = (i - 1) * step;
        const y = getY(i), py = getY(i - 1);
        ctx.bezierCurveTo(px + step * 0.4, py, x - step * 0.4, y, x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0,   'rgba(0, 212, 255, 0.9)');
    grad.addColorStop(0.5, 'rgba(100, 80, 255, 0.9)');
    grad.addColorStop(1,   'rgba(155, 0, 255, 0.9)');
    ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h);
    ctx.fillStyle = 'rgba(0, 212, 255, 0.04)'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.stroke();
}

// ═══════════════════════════════════════════════════════════
//  PANEL TOGGLE
// ═══════════════════════════════════════════════════════════
const PANELS  = ['eq-panel', 'pl-panel', 'settings-panel'];
const BUTTONS = ['eq-btn',   'pl-btn',   'set-btn'];

window.togglePanel = (id, btnId) => {
    PANELS.forEach(p => {
        if (p !== id) document.getElementById(p).classList.remove('open');
    });
    const el   = document.getElementById(id);
    const open = el.classList.toggle('open');
    BUTTONS.forEach(b => {
        document.getElementById(b)?.classList.toggle('lit', b === btnId && open);
    });
    document.getElementById('panel-backdrop').classList.toggle('show', open);
    if (id === 'eq-panel' && open) drawEQCurve();
};

window.closeAllPanels = () => {
    PANELS.forEach(p => document.getElementById(p).classList.remove('open'));
    BUTTONS.forEach(b => document.getElementById(b)?.classList.remove('lit'));
    document.getElementById('panel-backdrop').classList.remove('show');
};

window.addEventListener('resize', () => {
    if (document.getElementById('eq-panel').classList.contains('open')) drawEQCurve();
});

// ═══════════════════════════════════════════════════════════
//  MAIN RENDER LOOP  — speakers + RGB only, no canvas vis
// ═══════════════════════════════════════════════════════════
let frame = 0;
function renderLoop() {
    requestAnimationFrame(renderLoop);
    if (!inited) return;

    frame++;

    // Smooth power transition
    currentPower += (targetPower - currentPower) * 0.06;
    root.style.setProperty('--power-mult', currentPower);

    // Frequency data read
    if (!audio.paused && anaL && anaR) {
        anaL.getByteFrequencyData(dataL);
        anaR.getByteFrequencyData(dataR);
    } else {
        // Decay toward silence when paused
        if (dataL) {
            for (let i = 0; i < dataL.length; i++) {
                dataL[i] = Math.max(0, dataL[i] - 5);
                dataR[i] = Math.max(0, dataR[i] - 5);
            }
        }
    }
    if (!dataL || !dataR) return;

    // Bass / sub energy (bins 1–8 ≈ 20–300 Hz at 1024 fft)
    let subL = 0, subR = 0;
    for (let i = 1; i < 9; i++) { subL += dataL[i]; subR += dataR[i]; }
    subL /= 8; subR /= 8;
    smSubL += (subL - smSubL) * 0.18;
    smSubR += (subR - smSubR) * 0.18;
    const bassPeak = Math.max(smSubL, smSubR);
    smBass += (bassPeak - smBass) * 0.12;

    // ── Speaker orbit rings ───────────────────────────────
    const circum      = 2 * Math.PI * 48;
    const stripLength = 40;
    const gap         = (circum / 2) - stripLength;
    document.getElementById('strip-l').setAttribute('stroke-dasharray', `${stripLength} ${gap}`);
    document.getElementById('strip-r').setAttribute('stroke-dasharray', `${stripLength} ${gap}`);

    if (!audio.paused) {
        const speedL = 0.5 + Math.pow(smSubL / 255, 2) * 15;
        const speedR = 0.5 + Math.pow(smSubR / 255, 2) * 15;
        orbitAngleL += speedL;
        orbitAngleR -= speedR;
        document.getElementById('orbit-l').style.transform = `rotate(${orbitAngleL}deg) scale(${1 + (smSubL / 255) * 0.15})`;
        document.getElementById('orbit-r').style.transform = `rotate(${orbitAngleR}deg) scale(${1 + (smSubR / 255) * 0.15})`;
    }

    root.style.setProperty('--bass-scale-l', 1 + (smSubL / 255) * 0.22);
    root.style.setProperty('--bass-scale-r', 1 + (smSubR / 255) * 0.22);
    root.style.setProperty('--bass-pulse',   smBass / 255);

    // ── RGB Color Logic ───────────────────────────────────
    if (state.rgbMode === 'flow') {
        hueBase = (hueBase + 0.18) % 360;
        root.style.setProperty('--rgb-l', `hsl(${hueBase}, 100%, 60%)`);
        root.style.setProperty('--rgb-r', `hsl(${(hueBase + 60) % 360}, 100%, 60%)`);
    } else if (state.rgbMode === 'pulse') {
        const v = Math.max(smSubL, smSubR);
        root.style.setProperty('--rgb-l', `hsl(195, ${80 + (v/255)*20}%, ${40 + (v/255)*30}%)`);
        root.style.setProperty('--rgb-r', `hsl(285, ${70 + (v/255)*20}%, ${35 + (v/255)*30}%)`);
    } else {
        // True Stereo — cyan left, violet right
        root.style.setProperty('--rgb-l', `hsl(192, 100%, ${45 + (smSubL/255)*20}%)`);
        root.style.setProperty('--rgb-r', `hsl(272, 100%, ${50 + (smSubR/255)*20}%)`);
    }

    root.style.setProperty('--glow-l', 0.08 + (smSubL / 255) * 0.45);
    root.style.setProperty('--glow-r', 0.08 + (smSubR / 255) * 0.45);
}

// ═══════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════
function fmt(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}
