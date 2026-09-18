/* Verge — client networking.
 *
 * This file owns the socket and nothing else. The game calls into it through
 * Net.* and reads Net.remote / Net.state; it never touches a WebSocket itself.
 *
 * What travels:
 *   up    hello, state (20/s), shot, class, mode, ping
 *   down  welcome, join, leave, snap (15/s), fire, hurt, heal, kill, spawn,
 *         shove, match, end, pong
 *
 * Your own movement is simulated locally and merely reported, so it never feels
 * laggy. Everyone else is interpolated between the last two snapshots, which
 * costs ~70 ms of positional lag and is the usual trade for smoothness.
 */
(function (global) {
'use strict';

const Net = {
  on: false,            // connected and in a room
  id: 0,
  room: 'main',
  name: 'Player',
  status: 'offline',    // offline | connecting | live | lost
  ping: 0,
  remote: new Map(),    // id -> {id,name,cls,bot,x,y,z,yaw,alive,hp,kills,deaths, px,pz,py,pyaw,t0,t1}
  match: null,          // {mode,label,map,mapName,target,time,classes}
  handlers: {},         // game supplies these
  lastSent: 0,
  sendHz: 20
};

let ws = null;
let sendAcc = 0;
let pingAcc = 0;
let pingSent = 0;
let retryAt = 0;
let wantConnect = false;

function log(){ if(Net.handlers.log) Net.handlers.log.apply(null, arguments); }
function emit(name, a, b){ const h = Net.handlers[name]; if(h) h(a, b); }

// ---------------------------------------------------------------------------
Net.url = function(){
  if(location.protocol === 'file:') return null;            // opened from disk
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + '/ws';
};

Net.connect = function(opts){
  opts = opts || {};
  Net.name = (opts.name || Net.name || 'Player').slice(0, 14);
  Net.room = opts.room || Net.room || 'main';
  const base = Net.url();
  if(!base){ Net.status = 'offline'; emit('status'); return false; }
  wantConnect = true;
  open(base, opts.mode || 'ffa', opts.cls || 0);
  return true;
};

Net.disconnect = function(){
  wantConnect = false;
  if(ws){ try { ws.close(); } catch(e){} }
  ws = null;
  Net.on = false; Net.status = 'offline';
  Net.remote.clear();
  emit('status');
};

function open(base, mode, cls){
  Net.status = 'connecting';
  emit('status');
  try {
    ws = new WebSocket(base + '?room=' + encodeURIComponent(Net.room) + '&mode=' + mode);
  } catch(e){
    Net.status = 'lost'; emit('status'); return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({t:'hello', name:Net.name, cls:cls}));
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch(e){ return; }
    handle(m);
  };
  ws.onclose = () => {
    const was = Net.on;
    Net.on = false;
    Net.status = wantConnect ? 'lost' : 'offline';
    Net.remote.clear();
    emit('status');
    if(was) emit('dropped');
    if(wantConnect) retryAt = performance.now() + 2500;
  };
  ws.onerror = () => { try { ws.close(); } catch(e){} };
}

function handle(m){
  switch(m.t){
    case 'welcome':
      Net.id = m.id;
      Net.on = true;
      Net.status = 'live';
      Net.match = m;
      Net.remote.clear();
      (m.roster || []).forEach(addRemote);
      Net.remote.delete(Net.id);
      emit('status');
      emit('match', m);
      break;

    case 'match':
      Net.match = m;
      emit('match', m);
      break;

    case 'join':
      if(m.id !== Net.id) addRemote(m);
      emit('roster');
      break;

    case 'leave':
      Net.remote.delete(m.id);
      emit('roster');
      break;

    case 'snap': {
      const t = performance.now();
      if(Net.match) Net.match.time = m.time;
      for(let i=0;i<m.e.length;i++){
        const e = m.e[i];
        const id = e[0];
        if(id === Net.id){                       // the server's view of me
          emit('selfState', {x:e[1], y:e[2], z:e[3], alive:!!e[5], hp:e[6]});
          continue;
        }
        let r = Net.remote.get(id);
        if(!r){ r = addRemote({id:id, name:'?', cls:0, bot:true}); }
        // shuffle last -> previous so we can interpolate between them
        r.px = r.x; r.py = r.y; r.pz = r.z; r.pyaw = r.yaw; r.t0 = r.t1;
        r.x = e[1]; r.y = e[2]; r.z = e[3]; r.yaw = e[4];
        r.alive = !!e[5]; r.hp = e[6]; r.state = e[7];
        r.t1 = t;
        if(r.t0 === undefined){ r.t0 = t - 66; r.px = r.x; r.py = r.y; r.pz = r.z; r.pyaw = r.yaw; }
      }
      break;
    }

    case 'fire':   emit('fire', m); break;
    case 'hurt':
      if(m.id === Net.id) emit('tookDamage', m);
      else { const r = Net.remote.get(m.id); if(r) r.hp = m.hp; emit('remoteHurt', m); }
      break;
    case 'heal':
      if(m.id === Net.id) emit('healed', m);
      break;
    case 'kill':   emit('kill', m); break;
    case 'spawn':  emit('spawned', m); break;
    case 'shove':  emit('shove', m); break;
    case 'end':    emit('matchEnd', m); break;
    case 'pong':   Net.ping = Math.round(performance.now() - pingSent); break;
  }
}

function addRemote(info){
  const r = {
    id: info.id, name: info.name || '?', cls: info.cls || 0, bot: !!info.bot,
    x:0, y:0, z:0, yaw:0, alive: info.alive !== false, hp: info.hp === undefined ? 100 : info.hp,
    kills: info.kills || 0, deaths: info.deaths || 0, state:0,
    px:0, py:0, pz:0, pyaw:0, t0:undefined, t1:0, avatar:null
  };
  Net.remote.set(r.id, r);
  return r;
}

// ---------------------------------------------------------------------------
// Called every frame by the game
// ---------------------------------------------------------------------------
Net.update = function(dt, me){
  if(wantConnect && !ws && retryAt && performance.now() > retryAt){
    retryAt = 0;
    open(Net.url(), Net.match ? Net.match.mode : 'ffa', me ? me.cls : 0);
  }
  if(!Net.on || !ws || ws.readyState !== 1) return;

  sendAcc += dt;
  if(sendAcc >= 1 / Net.sendHz && me){
    sendAcc = 0;
    ws.send(JSON.stringify({
      t:'state',
      x:+me.x.toFixed(2), y:+me.y.toFixed(2), z:+me.z.toFixed(2),
      yaw:+me.yaw.toFixed(3), pitch:+me.pitch.toFixed(3),
      s: me.state | 0
    }));
  }
  pingAcc += dt;
  if(pingAcc > 3){
    pingAcc = 0; pingSent = performance.now();
    ws.send(JSON.stringify({t:'ping', c:pingSent}));
  }
};

// Position remote entities for rendering. Interpolates between the last two
// snapshots, one snapshot interval behind, which is what stops other players
// from jittering when a packet is late.
Net.interpolate = function(){
  const now = performance.now(), DELAY = 80;
  Net.remote.forEach(r => {
    if(r.t0 === undefined) return;
    const span = Math.max(1, r.t1 - r.t0);
    let a = (now - DELAY - r.t0) / span;
    a = a < 0 ? 0 : (a > 1.6 ? 1.6 : a);          // allow a little extrapolation
    r.rx = r.px + (r.x - r.px) * a;
    r.ry = r.py + (r.y - r.py) * a;
    r.rz = r.pz + (r.z - r.pz) * a;
    let d = ((r.yaw - r.pyaw + Math.PI) % (Math.PI*2)) - Math.PI;
    if(d < -Math.PI) d += Math.PI*2;
    r.ryaw = r.pyaw + d * Math.min(1, a);
    r.speed = Math.hypot(r.x - r.px, r.z - r.pz) / (span / 1000);
  });
};

Net.sendShot = function(weaponKey, hits){
  if(!Net.on || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({t:'shot', w:weaponKey, hits:hits}));
};
Net.sendClass = function(cls){
  if(!Net.on || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({t:'class', cls:cls}));
};
Net.sendMode = function(mode){
  if(!Net.on || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({t:'mode', mode:mode}));
};

Net.scoreboard = function(me){
  const rows = [];
  if(me) rows.push({name:'You', cls:me.cls, kills:me.kills, deaths:me.deaths, me:true, bot:false});
  Net.remote.forEach(r => rows.push({name:r.name, cls:r.cls, kills:r.kills, deaths:r.deaths, bot:r.bot}));
  rows.sort((a,b) => b.kills - a.kills || a.deaths - b.deaths);
  return rows;
};

global.Net = Net;
})(window);
