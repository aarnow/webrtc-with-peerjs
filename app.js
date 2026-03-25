import Peer from 'https://esm.sh/peerjs@1.5.4';

// ─────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────
const MAX_PEERS = 11; // max pairs distants (total session = MAX_PEERS + 1 = 12)

// Contraintes vidéo adaptées au mesh à grande échelle.
// Moins de résolution/framerate = moins de bande passante par flux.
// À 12 participants chaque client envoie 11 flux simultanément.
// Contraintes vidéo — volontairement simples pour compatibilité maximale
// PC et Android. Les contraintes "ideal" sont des suggestions, pas des exigences :
// le navigateur fait de son mieux sans rejeter l'appel.
const VIDEO_CONSTRAINTS = {
    video: { width: { ideal: 320 }, height: { ideal: 180 } },
    audio: true,
};

// ─────────────────────────────────────────────────────────────
//  État global
// ─────────────────────────────────────────────────────────────
let localStream = null;

/**
 * activePeers : Map<peerId, { call: MediaConnection|null, conn: DataConnection|null }>
 */
const activePeers = new Map();

// ─────────────────────────────────────────────────────────────
//  Initialisation PeerJS  (en premier — avant tout peer.on)
// ─────────────────────────────────────────────────────────────
// ID à 8 caractères alphanumériques — réduit les collisions sur le serveur PeerJS public
// (9000 combinaisons à 4 chiffres = trop peu quand plusieurs sessions coexistent)
const myId = Math.random().toString(36).slice(2, 6).toUpperCase()
    + Math.random().toString(36).slice(2, 6).toUpperCase();
const peer  = new Peer(myId);

document.getElementById('my-id').textContent = myId;

peer.on('open', () => {
    setStatus('CONNECTÉ', 'connected');
    document.getElementById('btn-call').disabled = false;
    log(`Prêt — ID : ${myId}`, 'ok');

    // Pré-initialiser la caméra en arrière-plan.
    // On catch toute erreur sans faire crasher le module —
    // la caméra sera re-demandée au moment de l'appel si besoin.
    getLocalMedia().catch(() => {});
});

peer.on('error', (err) => {
    log(`Erreur PeerJS : ${err.type} — ${err.message}`, 'err');
    setStatus('ERREUR', '');
});

// ─────────────────────────────────────────────────────────────
//  Log & statut
// ─────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
    const el  = document.getElementById('log');
    const now = new Date().toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const entry = document.createElement('div');
    entry.className = `entry ${type}`;
    entry.innerHTML = `<span class="time">${now}</span><span class="msg">${msg}</span>`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
}

function setStatus(text, cls) {
    document.getElementById('status-badge').className   = cls;
    document.getElementById('status-text').textContent  = text;
}

// ─────────────────────────────────────────────────────────────
//  Média local
// ─────────────────────────────────────────────────────────────
async function getLocalMedia() {
    if (localStream) return localStream;

    try {
        // Tentative avec les contraintes idéales (résolution réduite)
        localStream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
    } catch (e) {
        // Fallback : contraintes minimales, acceptées par tous les navigateurs
        log(`Contraintes vidéo refusées (${e.message}), fallback…`, 'info');
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }

    const v = document.getElementById('local-video');
    v.srcObject = localStream;
    // local-video est muted dans le HTML → autoplay garanti sans geste
    document.getElementById('local-placeholder').style.display = 'none';
    log('Caméra et micro activés', 'ok');

    return localStream;
}

// ─────────────────────────────────────────────────────────────
//  Grille vidéo
// ─────────────────────────────────────────────────────────────
function updateGrid() {
    const total   = 1 + activePeers.size;
    const slotsEl = document.getElementById('slots-info');
    const left    = MAX_PEERS - activePeers.size;

    document.getElementById('video-grid').className      = `video-grid count-${Math.min(total, MAX_PEERS + 1)}`;
    document.getElementById('participant-count').textContent = total;
    document.getElementById('btn-call').disabled         = left === 0;
    document.getElementById('btn-hangup').classList.toggle('hidden', activePeers.size === 0);

    slotsEl.textContent = left === 0
        ? 'Session pleine'
        : `${left} slot${left > 1 ? 's' : ''} libre${left > 1 ? 's' : ''}`;
    slotsEl.className = 'slots-info' + (left === 0 ? ' full' : '');

    if (activePeers.size > 0) {
        setStatus(`EN APPEL (${total}/${MAX_PEERS + 1})`, 'in-call');
        setChatEnabled(true);
    } else {
        setChatEnabled(false);
    }

    updatePeersPanel();
}

function addVideoSlot(peerId) {
    if (document.getElementById(`wrap-${peerId}`)) return;

    const wrap = document.createElement('div');
    wrap.className = 'video-wrap';
    wrap.id = `wrap-${peerId}`;
    wrap.innerHTML = `
        <div class="video-placeholder" id="ph-${peerId}">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M15 10l4.553-2.069A1 1 0 0121 8.867v6.266a1 1 0 01-1.447.9L15 14
                         M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
            </svg>
            <span>Connexion...</span>
        </div>
        <video id="vid-${peerId}" autoplay playsinline muted></video>
        <div class="video-label">${peerId}</div>`;

    document.getElementById('video-grid').appendChild(wrap);
}

function removeVideoSlot(peerId) {
    document.getElementById(`wrap-${peerId}`)?.remove();

    // Supprimer aussi l'élément <audio> séparé
    const audio = document.getElementById(`audio-${peerId}`);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
    }
}

function attachStream(peerId, stream) {
    const video = document.getElementById(`vid-${peerId}`);
    if (!video) { log(`Slot vidéo manquant pour ${peerId}`, 'err'); return; }

    // Sur Android WebView, modifier muted après coup gèle la vidéo sur la 1ère frame.
    // Solution : <video> reste muted en permanence (image uniquement),
    //            un <audio> séparé gère le son (pas de restriction autoplay sur Android).
    video.muted    = true;
    video.srcObject = stream;

    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
        audio          = document.createElement('audio');
        audio.id       = `audio-${peerId}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
    }
    audio.srcObject = new MediaStream(stream.getAudioTracks());

    document.getElementById(`ph-${peerId}`)?.style.setProperty('display', 'none');
    log(`Flux vidéo reçu de ${peerId} ✓`, 'ok');
}

// ─────────────────────────────────────────────────────────────
//  Panneau des pairs connectés
// ─────────────────────────────────────────────────────────────
function updatePeersPanel() {
    const panel = document.getElementById('peers-panel');
    panel.querySelectorAll('.peer-chip').forEach(c => c.remove());

    const noMsg = document.getElementById('no-peers-msg');
    if (activePeers.size === 0) {
        noMsg.style.display = '';
        return;
    }
    noMsg.style.display = 'none';

    activePeers.forEach((_, id) => {
        const chip = document.createElement('span');
        chip.className = 'peer-chip';
        chip.innerHTML = `${id} <button onclick="window.disconnectPeer('${id}')">✕</button>`;
        panel.appendChild(chip);
    });
}

// ─────────────────────────────────────────────────────────────
//  Helpers Map des pairs
// ─────────────────────────────────────────────────────────────
function ensurePeer(peerId) {
    if (!activePeers.has(peerId)) {
        activePeers.set(peerId, { call: null, conn: null });
    }
    return activePeers.get(peerId);
}

// ─────────────────────────────────────────────────────────────
//  Appel média sortant
// ─────────────────────────────────────────────────────────────
async function callPeer(peerId) {
    if (!localStream) await getLocalMedia();

    if (activePeers.has(peerId) && activePeers.get(peerId).call) {
        log(`Appel déjà actif vers ${peerId}`, 'info');
        return;
    }
    if (activePeers.size >= MAX_PEERS && !activePeers.has(peerId)) {
        log(`Session pleine, impossible d'appeler ${peerId}`, 'err');
        return;
    }

    log(`Appel média → ${peerId}`, 'info');
    addVideoSlot(peerId);

    const info = ensurePeer(peerId);
    const call = peer.call(peerId, localStream);
    info.call  = call;

    // Enregistrer 'stream' immédiatement après peer.call(),
    // avant tout await, pour ne jamais rater l'événement.
    call.on('stream', (stream) => { attachStream(peerId, stream); updateGrid(); startStats(); });
    call.on('close',  ()       => onPeerLeft(peerId));
    call.on('error',  (err)    => { log(`Erreur appel ${peerId} : ${err}`, 'err'); onPeerLeft(peerId); });

    updateGrid();
}

// ─────────────────────────────────────────────────────────────
//  Appel média entrant
// ─────────────────────────────────────────────────────────────
peer.on('call', (call) => {
    const peerId = call.peer;
    log(`Appel entrant de ${peerId}`, 'info');

    if (activePeers.size >= MAX_PEERS && !activePeers.has(peerId)) {
        log(`Session pleine — refus de ${peerId}`, 'err');
        call.close();
        return;
    }

    // Slot DOM + listeners EN PREMIER, avant tout await —
    // sinon le stream remote peut arriver pendant getLocalMedia() et être perdu.
    addVideoSlot(peerId);
    const info = ensurePeer(peerId);
    info.call  = call;

    call.on('stream', (stream) => { attachStream(peerId, stream); updateGrid(); startStats(); });
    call.on('close',  ()       => onPeerLeft(peerId));
    call.on('error',  (err)    => { log(`Erreur appel ${peerId} : ${err}`, 'err'); onPeerLeft(peerId); });

    updateGrid();

    // Répondre dès que le stream local est prêt.
    // getLocalMedia() est déjà résolu si l'init préventive a fonctionné.
    getLocalMedia()
        .then(stream => {
            call.answer(stream);
            log(`Réponse envoyée à ${peerId} ✓`, 'ok');
        })
        .catch(err => {
            log(`Impossible d'accéder à la caméra pour répondre à ${peerId} : ${err.message}`, 'err');
            call.close();
            onPeerLeft(peerId);
        });
});

// ─────────────────────────────────────────────────────────────
//  DataConnections  (signaling mesh + chat)
// ─────────────────────────────────────────────────────────────
/*
 * Protocole de messages :
 *   { type: 'hello', peers: ['ID1', 'ID2', ...] }
 *       → envoyé par l'hôte au nouveau pair : liste des autres membres
 *       → le nouveau pair appelle chacun de ces IDs
 *
 *   { type: 'bye' }
 *       → notifie qu'on quitte proprement
 *
 *   { type: 'chat', text: string, time: string }
 *       → message texte broadcasté à tous les pairs
 */

function setupDataConn(conn) {
    const peerId = conn.peer;

    conn.on('data', async (msg) => {
        if (msg.type === 'hello') {
            log(`hello reçu de ${peerId}, pairs : [${msg.peers.join(', ')}]`, 'info');
            for (const id of msg.peers) {
                if (id !== myId && (!activePeers.has(id) || !activePeers.get(id).call)) {
                    openDataConn(id);
                    await callPeer(id);
                }
            }
        }

        if (msg.type === 'bye') {
            onPeerLeft(peerId);
        }

        if (msg.type === 'chat') {
            displayMessage(peerId, msg.text, msg.time);
        }
    });

    conn.on('close', () => onPeerLeft(peerId));
    conn.on('error', (err) => log(`DataConn ${peerId} : ${err}`, 'err'));
}

function openDataConn(peerId) {
    if (activePeers.has(peerId) && activePeers.get(peerId).conn) return;

    const conn = peer.connect(peerId, { reliable: true });
    ensurePeer(peerId).conn = conn;

    conn.on('open', () => {
        log(`DataConn ouverte → ${peerId}`, 'ok');
        displaySystemMessage(`${peerId} a rejoint la session`);
    });

    setupDataConn(conn);
}

// Réception d'une DataConnection entrante
peer.on('connection', (conn) => {
    const peerId = conn.peer;
    log(`DataConn entrante ← ${peerId}`, 'info');
    ensurePeer(peerId).conn = conn;

    conn.on('open', () => {
        // Envoyer la liste de tous les pairs déjà connectés (sauf le nouveau)
        const currentPeers = [...activePeers.keys()].filter(id => id !== peerId);
        conn.send({ type: 'hello', peers: currentPeers });
        log(`hello envoyé à ${peerId}, pairs : [${currentPeers.join(', ')}]`, 'ok');
    });

    setupDataConn(conn);
});

// ─────────────────────────────────────────────────────────────
//  Départ d'un pair
// ─────────────────────────────────────────────────────────────
function onPeerLeft(peerId) {
    if (!activePeers.has(peerId)) return;

    log(`${peerId} a quitté`, 'info');
    displaySystemMessage(`${peerId} a quitté la session`);

    const info = activePeers.get(peerId);
    try { info.call?.close(); } catch (_) {}

    activePeers.delete(peerId);
    removeVideoSlot(peerId);
    updateGrid();

    if (activePeers.size === 0) setStatus('CONNECTÉ', 'connected');
}

// ─────────────────────────────────────────────────────────────
//  Chat
// ─────────────────────────────────────────────────────────────
let unreadCount = 0;

function chatTime() {
    return new Date().toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function displayMessage(fromId, text, time) {
    const isMe      = fromId === myId;
    const container = document.getElementById('chat-messages');

    const msg = document.createElement('div');
    msg.className = `chat-msg ${isMe ? 'me' : 'them'}`;
    msg.innerHTML = `
        <span class="meta">${isMe ? 'Vous' : fromId} · ${time || chatTime()}</span>
        <span class="bubble">${escapeHtml(text)}</span>`;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;

    if (!isMe) {
        unreadCount++;
        const badge = document.getElementById('unread-badge');
        badge.textContent = unreadCount;
        badge.classList.remove('hidden');
    }
}

function displaySystemMessage(text) {
    const container = document.getElementById('chat-messages');
    const msg = document.createElement('div');
    msg.className = 'chat-sys';
    msg.textContent = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
}

function setChatEnabled(enabled) {
    document.getElementById('chat-input').disabled    = !enabled;
    document.getElementById('chat-send-btn').disabled = !enabled;
}

// Réinitialiser le badge quand on scrolle jusqu'en bas
document.getElementById('chat-messages').addEventListener('scroll', function () {
    if (this.scrollTop + this.clientHeight >= this.scrollHeight - 10) {
        unreadCount = 0;
        const badge = document.getElementById('unread-badge');
        badge.textContent = '0';
        badge.classList.add('hidden');
    }
});

// ─────────────────────────────────────────────────────────────
//  API publique (appelée depuis le HTML via onclick)
// ─────────────────────────────────────────────────────────────
window.startCall = async function () {
    const input  = document.getElementById('peer-id-input');
    const peerId = input.value.trim().toUpperCase();

    if (!peerId)                                                     { log('Entrez un ID valide', 'err'); return; }
    if (peerId === myId)                                             { log('Vous ne pouvez pas vous appeler vous-même', 'err'); return; }
    if (activePeers.has(peerId) && activePeers.get(peerId).call)    { log(`Déjà connecté à ${peerId}`, 'err'); return; }
    if (activePeers.size >= MAX_PEERS)                              { log(`Session pleine (${MAX_PEERS + 1}/${MAX_PEERS + 1})`, 'err'); return; }

    setStatus('APPEL EN COURS...', 'calling');
    try {
        await getLocalMedia();
        openDataConn(peerId); // ouvre le data channel → recevra hello avec la liste des pairs
        await callPeer(peerId);
        input.value = '';
    } catch (err) {
        log(`Échec : ${err.message}`, 'err');
        setStatus('CONNECTÉ', 'connected');
    }
};

window.disconnectPeer = function (peerId) {
    const info = activePeers.get(peerId);
    if (info) {
        try { info.conn?.send({ type: 'bye' }); info.conn?.close(); } catch (_) {}
        try { info.call?.close(); } catch (_) {}
    }
    activePeers.delete(peerId);
    removeVideoSlot(peerId);
    log(`Déconnecté de ${peerId}`, 'info');
    updateGrid();
    if (activePeers.size === 0) setStatus('CONNECTÉ', 'connected');
};

window.endAllCalls = function () {
    activePeers.forEach((info, id) => {
        try { info.conn?.send({ type: 'bye' }); info.conn?.close(); } catch (_) {}
        try { info.call?.close(); } catch (_) {}
        removeVideoSlot(id);
    });
    activePeers.clear();

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    document.getElementById('local-video').srcObject        = null;
    document.getElementById('local-placeholder').style.display = '';

    stopStats();
    setStatus('CONNECTÉ', 'connected');
    log('Session terminée', 'info');
    updateGrid();
};

window.sendChatMessage = function () {
    const input = document.getElementById('chat-input');
    const text  = input.value.trim();
    if (!text || activePeers.size === 0) return;

    const time = chatTime();
    const msg  = { type: 'chat', text, time };

    let sent = 0;
    activePeers.forEach((info) => {
        if (info.conn) {
            try { info.conn.send(msg); sent++; } catch (_) {}
        }
    });

    if (sent > 0) {
        displayMessage(myId, text, time);
        input.value = '';
    } else {
        log('Aucune connexion data disponible pour envoyer le message', 'err');
    }
};

// ─────────────────────────────────────────────────────────────
//  Stats WebRTC  (RTCPeerConnection.getStats)
// ─────────────────────────────────────────────────────────────

let statsIntervalId  = null;

// Mémoriser les bytes précédents pour calculer le débit delta
const prevBytes = new Map(); // peerId → { bytesSent, bytesReceived, ts }

// Totaux précédents pour le débit global
let prevGlobal = { bytesSent: 0, bytesReceived: 0, ts: Date.now() };

function startStats() {
    if (statsIntervalId) return;
    document.getElementById('stats-panel').classList.remove('hidden');
    statsIntervalId = setInterval(collectStats, 2000);
    collectStats(); // premier appel immédiat
}

function stopStats() {
    if (statsIntervalId) { clearInterval(statsIntervalId); statsIntervalId = null; }
    document.getElementById('stats-panel').classList.add('hidden');
    document.getElementById('stats-peers-body').innerHTML = '';
    prevBytes.clear();
    // Remettre les chips globaux à zéro
    ['stat-connections','stat-send-total','stat-recv-total','stat-send-rate','stat-recv-rate']
        .forEach(id => { document.getElementById(id).textContent = '—'; });
}

async function collectStats() {
    if (activePeers.size === 0) { stopStats(); return; }

    const now = Date.now();
    document.getElementById('stats-refresh').textContent =
        `Actualisation : ${new Date().toLocaleTimeString('fr', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;

    let globalSent = 0, globalRecv = 0;
    const rows = [];

    for (const [peerId, info] of activePeers) {
        const pc = info.call?.peerConnection;
        if (!pc) continue;

        let row = {
            peerId,
            iceState:  pc.iceConnectionState,
            rtt:       null,
            sendKbps:  null,
            recvKbps:  null,
            lostVideo: null,
            width:     null,
            height:    null,
            fps:       null,
            bytesSent: 0,
            bytesRecv: 0,
        };

        try {
            const stats = await pc.getStats();

            stats.forEach(report => {

                // ── Paire ICE candidate sélectionnée → RTT ──────────
                if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
                    if (report.currentRoundTripTime != null) {
                        row.rtt = Math.round(report.currentRoundTripTime * 1000); // ms
                    }
                }

                // ── Flux sortant (outbound-rtp) ──────────────────────
                if (report.type === 'outbound-rtp' && report.kind === 'video') {
                    row.bytesSent += report.bytesSent || 0;
                }
                if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    row.bytesSent += report.bytesSent || 0;
                }

                // ── Flux entrant (inbound-rtp) ───────────────────────
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    row.bytesRecv  += report.bytesReceived  || 0;
                    row.lostVideo   = report.packetsLost    || 0;
                    row.width       = report.frameWidth     || null;
                    row.height      = report.frameHeight    || null;
                    row.fps         = report.framesPerSecond != null
                        ? Math.round(report.framesPerSecond) : null;
                }
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    row.bytesRecv += report.bytesReceived || 0;
                }
            });

        } catch (_) { /* PC peut être en cours de fermeture */ }

        // Calcul débit delta pour ce pair
        const prev = prevBytes.get(peerId);
        if (prev) {
            const dt = (now - prev.ts) / 1000; // secondes
            row.sendKbps = Math.round(((row.bytesSent - prev.bytesSent) * 8) / dt / 1000);
            row.recvKbps = Math.round(((row.bytesRecv - prev.bytesRecv) * 8) / dt / 1000);
        }
        prevBytes.set(peerId, { bytesSent: row.bytesSent, bytesReceived: row.bytesRecv, ts: now });

        globalSent += row.bytesSent;
        globalRecv += row.bytesRecv;
        rows.push(row);
    }

    // ── Métriques globales ───────────────────────────────────
    const dtGlobal = (now - prevGlobal.ts) / 1000;
    const globalSendRate = Math.round(((globalSent - prevGlobal.bytesSent) * 8) / dtGlobal / 1000);
    const globalRecvRate = Math.round(((globalRecv - prevGlobal.bytesReceived) * 8) / dtGlobal / 1000);
    prevGlobal = { bytesSent: globalSent, bytesReceived: globalRecv, ts: now };

    document.getElementById('stat-connections').textContent  = activePeers.size;
    document.getElementById('stat-send-total').textContent   = formatBytes(globalSent);
    document.getElementById('stat-recv-total').textContent   = formatBytes(globalRecv);
    document.getElementById('stat-send-rate').textContent    = `${Math.max(0, globalSendRate)} kbps`;
    document.getElementById('stat-recv-rate').textContent    = `${Math.max(0, globalRecvRate)} kbps`;

    // Colorer le débit global
    colorStatChip('stat-send-rate', globalSendRate, 500, 1500);
    colorStatChip('stat-recv-rate', globalRecvRate, 500, 1500);

    // ── Tableau par pair ─────────────────────────────────────
    const tbody = document.getElementById('stats-peers-body');
    tbody.innerHTML = '';

    for (const r of rows) {
        const tr = document.createElement('tr');

        const iceClass = {
            connected:    'state-connected',
            completed:    'state-connected',
            checking:     'state-checking',
            failed:       'state-failed',
            disconnected: 'state-failed',
            closed:       'state-closed',
        }[r.iceState] || '';

        const rttClass  = r.rtt  == null ? '' : r.rtt < 100 ? 'ok' : r.rtt < 300 ? 'warn' : 'bad';
        const lostClass = r.lostVideo == null ? '' : r.lostVideo === 0 ? 'ok' : r.lostVideo < 10 ? 'warn' : 'bad';

        tr.innerHTML = `
            <td>${r.peerId}</td>
            <td class="${iceClass}">${r.iceState}</td>
            <td class="${rttClass}">${r.rtt != null ? r.rtt + ' ms' : '—'}</td>
            <td>${r.sendKbps != null ? Math.max(0, r.sendKbps) : '—'}</td>
            <td>${r.recvKbps != null ? Math.max(0, r.recvKbps) : '—'}</td>
            <td class="${lostClass}">${r.lostVideo != null ? r.lostVideo : '—'}</td>
            <td>${r.width && r.height ? r.width + '×' + r.height : '—'}</td>
            <td>${r.fps != null ? r.fps : '—'}</td>`;
        tbody.appendChild(tr);
    }
}

function colorStatChip(id, value, warnThreshold, badThreshold) {
    const el = document.getElementById(id);
    el.classList.remove('warn', 'bad');
    if (value > badThreshold)  el.classList.add('bad');
    else if (value > warnThreshold) el.classList.add('warn');
}

function formatBytes(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

window.toggleMic = function () {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    const btn = document.getElementById('btn-mic');
    btn.textContent = track.enabled ? '🎤 Micro ON' : '🔇 Micro OFF';
    btn.classList.toggle('off', !track.enabled);
};

window.toggleCam = function () {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    const btn = document.getElementById('btn-cam');
    btn.textContent = track.enabled ? '📷 Caméra ON' : '🚫 Caméra OFF';
    btn.classList.toggle('off', !track.enabled);
};