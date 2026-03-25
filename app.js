import Peer from 'https://esm.sh/peerjs@1.5.4';

// ─────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────
const MAX_PEERS = 11; // max pairs distants (total session = MAX_PEERS + 1 = 12)

// Contraintes vidéo adaptées au mesh à grande échelle.
// Moins de résolution/framerate = moins de bande passante par flux.
// À 12 participants chaque client envoie 11 flux simultanément.
// Contraintes adaptées PC et Android — sans facingMode qui bloque les webcams PC.
// Android utilisera la caméra frontale par défaut sans avoir à le forcer.
const VIDEO_CONSTRAINTS = {
    video: {
        width:     { ideal: 320 },
        height:    { ideal: 180 },
        frameRate: { ideal: 15, max: 20 },
    },
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
    },
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

    // Démarrer la caméra dès que PeerJS est prêt.
    // Sur Android les permissions sont déjà accordées par MainActivity,
    // donc ça ne bloque pas. But : localStream est prêt avant tout appel entrant.
    getLocalMedia().catch(err => log(`Init caméra : ${err.message}`, 'err'));
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

    localStream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);

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
    document.getElementById('btn-hangup').classList.toggle('visible', activePeers.size > 0);

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
    call.on('stream', (stream) => { attachStream(peerId, stream); updateGrid(); });
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

    call.on('stream', (stream) => { attachStream(peerId, stream); updateGrid(); });
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
        badge.classList.add('visible');
    }
}

function displaySystemMessage(text) {
    const container = document.getElementById('chat-messages');
    const msg = document.createElement('div');
    msg.className = 'chat-msg system';
    msg.innerHTML = `<span class="bubble">${escapeHtml(text)}</span>`;
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
        badge.classList.remove('visible');
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

window.toggleMic = function () {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    const btn = document.getElementById('btn-mic');
    btn.textContent = track.enabled ? '🎤 Micro ON' : '🔇 Micro OFF';
    btn.classList.toggle('muted', !track.enabled);
};

window.toggleCam = function () {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    const btn = document.getElementById('btn-cam');
    btn.textContent = track.enabled ? '📷 Caméra ON' : '🚫 Caméra OFF';
    btn.classList.toggle('muted', !track.enabled);
};