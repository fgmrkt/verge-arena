/* Verge — game server.
 *
 * Authority model (read this before changing anything):
 *
 *   The server owns  : room membership, which map, the match clock, every
 *                      player's health / kills / deaths / respawns, and the
 *                      full simulation of bots.
 *   The client owns  : where its own player is standing, and whether a shot
 *                      it fired hit something.
 *
 * That split keeps the client feeling instant (no input lag on your own
 * movement, no waiting for the server to confirm a hit) at the cost of being
 * cheatable by a determined player who edits the JS. For a game you play with
 * friends on your own domain that is the right trade. The server still sanity
 * checks every hit claim — range, rate of fire, line of sight, target alive —
 * so casual nonsense bounces, but do not mistake it for anti-cheat.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { WebSocketServer } = require('ws');
const World = require('../public/world.js');

const PORT      = process.env.PORT || 8080;
const PUBLIC    = path.join(__dirname, '..', 'public');
const TICK_HZ   = 30;
const SNAP_HZ   = 15;                      // snapshots are cheap; 15/s interpolates fine
const IDLE_KICK = 45000;

// ---------------------------------------------------------------------------
// Rules, mirrored from the client. The client renders these; the server enforces.
// ---------------------------------------------------------------------------
const MODES = {
  ffa:   {label:'FFA',       fill:10, target:15, time:360, knock:0, kind:'ffa',
          classes:[0,1,2,3], skill:'random'},
  duel:  {label:'1v1',       fill:2,  target:10, time:300, knock:0, kind:'duel',
          classes:[0,1,2,3], skill:'duel'},
  knock: {label:'Knockback', fill:6,  target:10, time:300, knock:1, kind:'knock',
          classes:[0,1],     skill:'knock'}
};

// bot skill profiles; FFA rolls one per bot, duels are always Even
// acc is the base chance a shot connects before range is taken into account
const SKILL = {
  casual: {spread:0.075, rof:0.70, dmg:4.5, react:0.50, speed:3.5, acc:0.42},
  even:   {spread:0.048, rof:0.52, dmg:6.0, react:0.34, speed:4.2, acc:0.55},
  sharp:  {spread:0.030, rof:0.40, dmg:8.0, react:0.22, speed:4.9, acc:0.70},
  knock:  {spread:0.038, rof:0.50, dmg:6.0, react:0.26, speed:4.4, acc:0.60},
  // the duel opponent: quick to react, accurate, and it pushes you
  duel:   {spread:0.020, rof:0.32, dmg:10,  react:0.14, speed:5.0, acc:0.82}
};
const SKILL_NAMES = ['casual','even','sharp'];

// per-class bot weapon behaviour (kdmg is the shove used in knockback)
const KIT = [
  {cls:0, rof:1.15, dmg:1.50, pellets:1, spread:1.00, fall:[30,66], hold:18, near:8,  reach:52, kdmg:30, kpel:1, burst:5, rate:0.13},
  {cls:1, rof:0.62, dmg:0.80, pellets:1, spread:1.15, fall:[18,40], hold:14, near:5,  reach:34, kdmg:15, kpel:1, burst:9, rate:0.075},
  {cls:2, rof:2.40, dmg:3.20, pellets:1, spread:0.55, fall:[150,200], hold:34, near:18, reach:70, kdmg:80, kpel:1, burst:1, rate:0.90},
  {cls:3, rof:1.90, dmg:0.72, pellets:4, spread:3.20, fall:[5,13],  hold:9,  near:3,  reach:18, kdmg:11, kpel:5, burst:3, rate:0.55}
];

// weapon damage the server will accept from a client hit claim
const ARMS = {
  ak:     {dmg:33,  rpm:600, pellets:1, range:110},
  usp:    {dmg:26,  rpm:400, pellets:1, range:90},
  p90:    {dmg:15,  rpm:900, pellets:1, range:80},
  deagle: {dmg:37,  rpm:220, pellets:1, range:100},
  awp:    {dmg:105, rpm:41,  pellets:1, range:260},
  pump:   {dmg:10,  rpm:70,  pellets:8, range:40}
};
const HEADSHOT = 2;
const KILL_HEAL = 15;
const SPAWN_CLEAR = 26;
const NAMES = ['Ash','Pike','Nova','Quill','Harlow','Bex','Sable','Corvo','Wren','Juno','Riot','Mox'];

const now = () => Date.now() / 1000;
const clamp = (v,a,b) => v<a?a:(v>b?b:v);
const rnd = (a,b) => a + Math.random()*(b-a);
const pick = a => a[(Math.random()*a.length)|0];

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
let nextId = 1;

class Room {
  constructor(name, modeKey){
    this.name = name;
    this.setMode(modeKey || 'ffa', true);
    this.players = new Map();          // id -> player
    this.bots = [];
    this.lastTick = now();
    this.acc = 0;
    this.snapAcc = 0;
  }

  setMode(modeKey, quiet){
    this.modeKey = MODES[modeKey] ? modeKey : 'ffa';
    this.mode = MODES[this.modeKey];
    this.mapIndex = (Math.random() * World.poolSize(this.mode.kind)) | 0;
    this.world = World.build(this.mode.kind, this.mapIndex);
    this.timeLeft = this.mode.time;
    this.over = false;
    this.startedAt = now();
    if(!quiet){
      this.bots = [];
      this.fill();                       // the new mode needs its own bots
      for(const p of this.players.values()) this.respawn(p, true);
      // send the roster with the match so clients can drop the previous mode's
      // fighters instead of keeping them around as ghosts
      this.broadcast({t:'match', ...this.matchInfo(), roster:this.roster()});
    }
  }

  matchInfo(){
    return {
      mode: this.modeKey, label: this.mode.label, map: this.mapIndex,
      mapName: this.world.name, target: this.mode.target,
      time: Math.max(0, Math.round(this.timeLeft)), classes: this.mode.classes
    };
  }

  // ---- membership -------------------------------------------------------
  add(ws, name){
    // fill() broadcasts a join per bot. Hold those back from the player who is
    // still joining: they get the whole roster in the welcome a moment later.
    const p = {
      id: nextId++, ws, bot:false,
      name: (name || 'Player').slice(0,14),
      cls: this.mode.classes[0],
      x:0, y:0, z:0, yaw:0, pitch:0, state:0,
      hp:100, alive:true, kills:0, deaths:0,
      respawnAt:0, lastSeen: Date.now(), lastShot:0, lastHitBy:null
    };
    this.players.set(p.id, p);
    this.respawn(p, true);
    this.quietFor = p.id;
    this.fill();
    this.quietFor = 0;
    p.ws.send(JSON.stringify({
      t:'welcome', id:p.id, room:this.name, ...this.matchInfo(),
      roster: this.roster()
    }));
    this.broadcast({t:'join', id:p.id, name:p.name, cls:p.cls, bot:false}, p.id);
    return p;
  }

  remove(id){
    const p = this.players.get(id);
    if(!p) return;
    this.players.delete(id);
    this.broadcast({t:'leave', id});
    this.fill();
  }

  humans(){ let n=0; for(const p of this.players.values()) n++; return n; }

  // top up with bots so a half empty lobby still plays
  fill(){
    const want = Math.max(0, this.mode.fill - this.humans());
    while(this.bots.length > want) this.bots.pop();
    while(this.bots.length < want){
      const skillKey = this.mode.skill === 'random' ? pick(SKILL_NAMES)
                     : (SKILL[this.mode.skill] ? this.mode.skill : 'even');
      let allowed = this.mode.classes.filter(c => !(this.mode.knock && c === 2));
      if(this.modeKey === 'duel') allowed = [0];          // rifle: reliable at any range
      const b = {
        id: nextId++, bot:true,
        name: pick(NAMES), cls: pick(allowed),
        skillKey, skill: SKILL[skillKey],
        x:0, y:0, z:0, yaw:0, pitch:0, state:0,
        hp:100, alive:true, kills:0, deaths:0, respawnAt:0,
        vx:0, vy:0, vz:0, onGround:true,
        foe:null, retarget:0, seen:0, burst:0, nextFire:0,
        target:null, stuck:0, strafe: Math.random()<.5?1:-1,
        knockLock:0, lastHitBy:null
      };
      this.bots.push(b);
      this.respawn(b, true);
      this.broadcast({t:'join', id:b.id, name:b.name, cls:b.cls, bot:true}, this.quietFor || undefined);
    }
  }

  everyone(){ return [...this.players.values(), ...this.bots]; }
  byId(id){ return this.players.get(id) || this.bots.find(b => b.id === id); }

  roster(){
    return this.everyone().map(e => ({
      id:e.id, name:e.name, cls:e.cls, bot:!!e.bot,
      kills:e.kills, deaths:e.deaths, alive:e.alive
    }));
  }

  // ---- spawning ---------------------------------------------------------
  spawnPoint(away){
    const sp = this.world.spawns;
    const far = [];
    let best = sp[0], bd = -1;
    for(const s of sp){
      let d = 1e9;
      for(const o of away){
        if(!o.alive) continue;
        const dd = Math.hypot(s[0]-o.x, s[1]-o.z);
        if(dd < d) d = dd;
      }
      if(d >= SPAWN_CLEAR) far.push(s);
      if(d > bd){ bd = d; best = s; }
    }
    return far.length ? pick(far) : best;
  }

  respawn(e, silent){
    const others = this.everyone().filter(o => o !== e);
    const s = this.spawnPoint(others);
    e.x = s[0]; e.y = this.world.spawnY; e.z = s[1];
    e.vx = e.vy = e.vz = 0;
    e.hp = 100; e.alive = true; e.respawnAt = 0;
    e.lastHitBy = null; e.knockLock = 0;
    e.yaw = Math.atan2(s[0], s[1]) + Math.PI;
    if(!this.mode.classes.includes(e.cls)) e.cls = this.mode.classes[0];
    if(!silent) this.broadcast({t:'spawn', id:e.id, x:e.x, y:e.y, z:e.z, cls:e.cls});
  }

  // ---- damage -----------------------------------------------------------
  hurt(victim, dmg, attacker, head){
    if(!victim || !victim.alive || this.over) return;
    if(this.mode.knock){
      // knockback mode: no damage at all, only shove. The client applies the
      // push to itself; the server just records who touched whom last so a
      // ring-out can be credited.
      if(attacker && attacker !== victim) victim.lastHitBy = attacker.id;
      return;
    }
    if(attacker && attacker !== victim) victim.lastHitBy = attacker.id;
    victim.hp -= dmg;
    this.broadcast({t:'hurt', id:victim.id, hp:Math.max(0,Math.round(victim.hp)),
                    by: attacker ? attacker.id : 0, head: !!head});
    if(victim.hp <= 0) this.kill(victim, attacker, head);
  }

  kill(victim, attacker, head){
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.respawnAt = now() + 2.2;
    if(attacker && attacker !== victim){
      attacker.kills++;
      attacker.hp = Math.min(100, attacker.hp + KILL_HEAL);
      this.broadcast({t:'heal', id:attacker.id, hp:Math.round(attacker.hp), amount:KILL_HEAL});
    }
    this.broadcast({t:'kill', victim:victim.id, by: attacker ? attacker.id : 0, head: !!head});
    this.checkWin();
  }

  ringOut(e){
    if(!e.alive) return;
    const by = e.lastHitBy ? this.byId(e.lastHitBy) : null;
    this.kill(e, by, false);
  }

  checkWin(){
    if(this.over) return;
    let lead = null;
    for(const e of this.everyone()) if(!lead || e.kills > lead.kills) lead = e;
    if(lead && lead.kills >= this.mode.target) this.end(lead);
  }

  end(winner){
    this.over = true;
    this.broadcast({t:'end', winner: winner ? winner.id : 0, roster:this.roster()});
    setTimeout(() => this.setMode(this.modeKey), 8000);   // next map
  }

  broadcast(msg, exceptId){
    const s = JSON.stringify(msg);
    for(const p of this.players.values()){
      if(p.id === exceptId) continue;
      if(p.ws.readyState === 1) p.ws.send(s);
    }
  }

  // ---- simulation -------------------------------------------------------
  tick(dt){
    const t = now();

    if(!this.over){
      this.timeLeft -= dt;
      if(this.timeLeft <= 0){
        let lead = null;
        for(const e of this.everyone()) if(!lead || e.kills > lead.kills) lead = e;
        this.end(lead);
      }
    }

    for(const e of this.everyone()){
      if(!e.alive && e.respawnAt && t >= e.respawnAt){
        this.respawn(e);
      }
    }
    for(const b of this.bots) this.thinkBot(b, dt, t);

    // drop players who stopped talking
    for(const p of [...this.players.values()]){
      if(Date.now() - p.lastSeen > IDLE_KICK){
        try { p.ws.close(4000, 'idle'); } catch(e){}
        this.remove(p.id);
      }
    }
  }

  snapshot(){
    const ents = this.everyone().map(e => [
      e.id,
      Math.round(e.x*100)/100, Math.round(e.y*100)/100, Math.round(e.z*100)/100,
      Math.round(e.yaw*1000)/1000,
      e.alive ? 1 : 0,
      Math.max(0, Math.round(e.hp)),
      e.state|0
    ]);
    return {t:'snap', time:Math.max(0,Math.round(this.timeLeft)), e:ents};
  }

  // ---- bot AI (server side, so every client sees the same bots) ----------
  canSee(from, fx,fy,fz, tx,ty,tz, maxD){
    const dx = tx-fx, dy = ty-fy, dz = tz-fz;
    const d = Math.hypot(dx,dy,dz);
    if(d > maxD) return -1;
    if(d < 0.001) return 0.001;
    const hit = World.raycast(this.world, fx,fy,fz, dx/d, dy/d, dz/d, d - 0.3);
    return hit < 0 ? d : -1;
  }

  thinkBot(b, dt, t){
    if(!b.alive) return;
    const W = this.world, K = KIT[b.cls], S = b.skill;
    const kn = this.mode.knock;

    // fell off the island
    if(!W.hasGround && b.y < -4){ this.ringOut(b); return; }

    b.knockLock = Math.max(0, b.knockLock - dt);

    // choose a foe
    b.retarget -= dt;
    if(b.retarget <= 0 || !b.foe || !this.byId(b.foe) || !this.byId(b.foe).alive){
      b.retarget = 0.35 + Math.random()*0.5;
      let best = null, bd = 1e9;
      for(const o of this.everyone()){
        if(o === b || !o.alive) continue;
        const d = this.canSee(b, b.x, b.y+1.5, b.z, o.x, o.y+1.15, o.z, K.reach);
        if(d > 0 && d < bd){ bd = d; best = o; }
      }
      b.foe = best ? best.id : null;
    }

    const foe = b.foe ? this.byId(b.foe) : null;
    let visible = false, dist = 0;
    if(foe && foe.alive){
      const d = this.canSee(b, b.x, b.y+1.5, b.z, foe.x, foe.y+1.15, foe.z, K.reach);
      if(d > 0){ visible = true; dist = d; }
    }
    b.seen = visible ? b.seen + dt : 0;
    if(!visible) b.burst = 0;

    let wx = 0, wz = 0;
    if(visible){
      const toF = Math.atan2(foe.x-b.x, foe.z-b.z);
      b.yaw = lerpAngle(b.yaw, toF, 1 - Math.pow(0.0005, dt));
      const hold = this.mode.skill === 'duel' ? K.hold * 0.55 : K.hold;
      const want = dist > hold ? 1 : (dist < K.near ? -0.7 : 0);
      wx = Math.sin(toF)*want + Math.sin(toF+Math.PI/2)*b.strafe*0.85;
      wz = Math.cos(toF)*want + Math.cos(toF+Math.PI/2)*b.strafe*0.85;
      if(Math.random() < dt*0.5) b.strafe *= -1;

      if(b.seen > S.react && t > b.nextFire){
        if(b.burst <= 0) b.burst = kn ? Math.ceil(K.burst*1.5) : K.burst;
        b.burst--;
        b.nextFire = t + (b.burst > 0 ? K.rate * rnd(0.88,1.15)
                                      : (kn ? 0.62*K.rof : S.rof*K.rof) * rnd(0.85,1.25));
        const pellets = kn ? K.kpel : K.pellets;
        const power   = kn ? K.kdmg : S.dmg * K.dmg;
        const spread  = S.spread * K.spread * (kn ? 0.70 : 1);
        for(let i=0;i<pellets;i++){
          // bots roll their own accuracy; a miss simply does nothing
          const acc = S.acc === undefined ? 0.55 : S.acc;
          if(Math.random() < Math.min(0.95, acc / (1 + spread*dist*6))){
            if(kn){
              this.broadcast({t:'shove', id:foe.id, fx:b.x, fz:b.z, power:power});
              if(foe !== b) foe.lastHitBy = b.id;
            } else {
              const fall = K.fall;
              const mult = dist<=fall[0] ? 1 : (dist>=fall[1] ? 0.42
                          : 1 - 0.58*(dist-fall[0])/(fall[1]-fall[0]));
              this.hurt(foe, power*mult, b, false);
            }
          }
        }
        this.broadcast({t:'fire', id:b.id, cls:b.cls, x:b.x, y:b.y+1.45, z:b.z, yaw:b.yaw});
      }
    } else {
      if(!b.target || Math.hypot(b.x-b.target.x, b.z-b.target.z) < 2.5 || b.stuck > 1.2){
        b.target = W.nav.length ? pick(W.nav) : {x:0,y:0,z:0};
        b.stuck = 0;
      }
      const ang = Math.atan2(b.target.x-b.x, b.target.z-b.z);
      b.yaw = lerpAngle(b.yaw, ang, 1 - Math.pow(0.002, dt));
      wx = Math.sin(ang); wz = Math.cos(ang);
    }

    // move
    const len = Math.hypot(wx,wz);
    if(len > 0.001){
      wx/=len; wz/=len;
      // do not walk off the island
      if(!W.hasGround && b.onGround &&
         World.freeAt(W.solids, b.x + wx*2.2, b.y - 0.6, b.z + wz*2.2, 0.4, 0.4)){
        const a = 1.6*b.strafe, c = Math.cos(a), s2 = Math.sin(a);
        const nx = wx*c - wz*s2, nz = wx*s2 + wz*c;
        wx = nx; wz = nz;
      }
      if(World.raycast(W, b.x, b.y+0.9, b.z, wx, 0, wz, 3.4) > 0){
        const a = 1.15*b.strafe, c = Math.cos(a), s2 = Math.sin(a);
        const nx = wx*c - wz*s2, nz = wx*s2 + wz*c;
        wx = nx; wz = nz;
      }
      const ctrl = b.knockLock > 0 ? 0.12 : 1;
      const speed = S.speed * (b.onGround ? 1 : ctrl);
      const cur = b.vx*wx + b.vz*wz;
      const add = speed - cur;
      if(add > 0){
        const acc = Math.min((b.onGround ? 11 : 2.4*ctrl) * dt * speed, add);
        b.vx += wx*acc; b.vz += wz*acc;
      }
    }
    if(b.onGround){
      const f = Math.max(0, 1 - 9*dt);
      b.vx *= f; b.vz *= f;
    }
    b.vy -= 23*dt;
    const before = b.x + b.z;
    integrate(W, b, dt, 0.4, 1.72);
    const moved = Math.abs((b.x + b.z) - before);
    if(moved < dt*0.6) b.stuck += dt; else b.stuck = Math.max(0, b.stuck - dt);
    b.state = b.alive ? 1 : 0;
  }
}

function lerpAngle(a,b,t){
  let d = ((b-a+Math.PI) % (Math.PI*2)) - Math.PI;
  if(d < -Math.PI) d += Math.PI*2;
  return a + d*t;
}
function moveAxis(W, e, delta, axis, r, h){
  if(delta === 0) return false;
  e[axis] += delta;
  let mx=e.x-r, Mx=e.x+r, my=e.y, My=e.y+h, mz=e.z-r, Mz=e.z+r;
  let blocked = false;
  for(let i=0;i<W.solids.length;i++){
    const b = W.solids[i];
    if(!World.overlaps(mx,my,mz,Mx,My,Mz,b)) continue;
    blocked = true;
    if(axis === 'x'){ e.x += delta>0 ? (b.mx-Mx) : (b.Mx-mx); mx=e.x-r; Mx=e.x+r; }
    else if(axis === 'z'){ e.z += delta>0 ? (b.mz-Mz) : (b.Mz-mz); mz=e.z-r; Mz=e.z+r; }
    else { e.y += delta>0 ? (b.my-My) : (b.My-my); my=e.y; My=e.y+h; }
  }
  return blocked;
}
function integrate(W, e, dt, r, h){
  const bx = moveAxis(W, e, e.vx*dt, 'x', r, h);
  const bz = moveAxis(W, e, e.vz*dt, 'z', r, h);
  if((bx||bz) && e.onGround){
    const y0 = e.y;
    if(World.freeAt(W.solids, e.x, y0+0.66, e.z, r, h)){ e.y = y0 + 0.66; moveAxis(W, e, -0.66, 'y', r, h); }
    else { if(bx) e.vx = 0; if(bz) e.vz = 0; }
  }
  e.onGround = false;
  if(moveAxis(W, e, e.vy*dt, 'y', r, h)){
    if(e.vy < 0) e.onGround = true;
    e.vy = 0;
  }
  if(W.hasGround && e.y <= 0){ e.y = 0; e.vy = 0; e.onGround = true; }
  const lim = W.half - 1.2;
  e.x = clamp(e.x, -lim, lim);
  e.z = clamp(e.z, -lim, lim);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------
const MIME = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
              '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon',
              '.json':'application/json'};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if(p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if(!file.startsWith(PUBLIC)){ res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if(err){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                        'Cache-Control': 'no-cache'});
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path:'/ws' });
const rooms = new Map();
function getRoom(name, mode){
  const key = (name || 'main').slice(0,24);
  if(!rooms.has(key)) rooms.set(key, new Room(key, mode));
  return rooms.get(key);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const room = getRoom(url.searchParams.get('room') || 'main',
                       url.searchParams.get('mode') || 'ffa');
  let me = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch(e){ return; }
    if(m.t === 'hello'){
      if(me) return;
      me = room.add(ws, m.name);
      if(m.cls !== undefined && room.mode.classes.includes(m.cls)) me.cls = m.cls;
      return;
    }
    if(!me) return;
    me.lastSeen = Date.now();

    switch(m.t){
      case 'state':                       // where I am, 20 times a second
        me.x = +m.x || 0; me.y = +m.y || 0; me.z = +m.z || 0;
        me.yaw = +m.yaw || 0; me.pitch = +m.pitch || 0;
        me.state = m.s | 0;
        if(!room.world.hasGround && me.y < -4 && me.alive) room.ringOut(me);
        break;

      case 'class':
        if(room.mode.classes.includes(m.cls|0)) me.cls = m.cls|0;
        break;

      case 'shot': {                      // "I fired, and I believe I hit these"
        const arm = ARMS[m.w];
        if(!arm) break;
        const t = now();
        const minGap = (60 / arm.rpm) * 0.7;          // allow for jitter
        if(t - me.lastShot < minGap) break;           // firing faster than the gun can
        me.lastShot = t;
        room.broadcast({t:'fire', id:me.id, cls:me.cls, x:me.x, y:me.y+1.5, z:me.z, yaw:me.yaw}, me.id);
        if(!Array.isArray(m.hits)) break;
        const seen = new Set();
        for(const h of m.hits.slice(0, arm.pellets)){
          const target = room.byId(h.id|0);
          if(!target || !target.alive || target === me) continue;
          const d = Math.hypot(target.x-me.x, target.y-me.y, target.z-me.z);
          if(d > arm.range + 5) continue;                       // out of the weapon's reach
          if(room.canSee(me, me.x, me.y+1.5, me.z, target.x, target.y+1.0, target.z, arm.range+5) < 0) continue;
          let dmg = arm.dmg * (h.head ? HEADSHOT : 1);
          if(h.falloff) dmg *= clamp(+h.falloff, 0.3, 1);
          if(room.mode.knock){
            room.broadcast({t:'shove', id:target.id, fx:me.x, fz:me.z, power:arm.dmg*(arm.pellets>1?1:2.2)});
            target.lastHitBy = me.id;
          } else {
            room.hurt(target, dmg, me, h.head);
          }
          seen.add(target.id);
        }
        break;
      }

      case 'mode':
        if(MODES[m.mode] && room.humans() <= 1) room.setMode(m.mode);
        break;

      case 'ping':
        ws.send(JSON.stringify({t:'pong', c:m.c}));
        break;
    }
  });

  ws.on('close', () => { if(me) room.remove(me.id); });
  ws.on('error', () => { if(me) room.remove(me.id); });
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = now();
setInterval(() => {
  const t = now();
  let dt = t - last;
  last = t;
  if(dt > 0.25) dt = 0.25;
  for(const room of rooms.values()){
    room.tick(dt);
    room.snapAcc += dt;
    if(room.snapAcc >= 1/SNAP_HZ){
      room.snapAcc = 0;
      const snap = JSON.stringify(room.snapshot());
      for(const p of room.players.values()) if(p.ws.readyState === 1) p.ws.send(snap);
    }
    if(room.players.size === 0 && room.bots.length && t - room.startedAt > 60){
      rooms.delete(room.name);            // nobody home, stop simulating
    }
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log('Verge server on http://localhost:' + PORT + '  (ws path /ws)');
});

module.exports = { Room, MODES, ARMS, SKILL };
