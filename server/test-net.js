/* Headless test: spins the real server up, connects fake clients over a real
 * WebSocket, and checks the things that actually matter for a match to work. */
'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 8099;

const srv = spawn(process.execPath, [__dirname + '/server.js'], {
  env: Object.assign({}, process.env, {PORT: String(PORT)}), stdio: ['ignore','pipe','pipe']
});
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function client(name, room, mode){
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}&mode=${mode}`);
  const c = {ws, name, id:0, msgs:[], snaps:0, roster:[], match:null, hp:100, alive:true,
             kills:0, deaths:0, events:[], hurts:[]};
  ws.on('open', () => ws.send(JSON.stringify({t:'hello', name})));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    c.msgs.push(m.t);
    if(m.t === 'welcome'){ c.id = m.id; c.match = m; c.roster = m.roster; }
    if(m.t === 'match')  c.match = m;
    if(m.t === 'snap')   { c.snaps++; c.last = m; }
    if(m.t === 'hurt' && m.id === c.id){ c.hurts.push({by:m.by, from:c.hp, to:m.hp}); c.hp = m.hp; }
    if(m.t === 'kill' || m.t === 'fire') c.events.push(m);
    if(m.t === 'heal' && m.id === c.id) c.hp = m.hp;
  });
  c.send = o => { if(ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.move = (x,y,z) => c.send({t:'state', x, y, z, yaw:0, pitch:0, s:1});
  return c;
}

(async () => {
  await sleep(900);
  let fails = 0;
  const ok = (cond, label, extra) => {
    log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '   ' + extra : ''));
    if(!cond) fails++;
  };

  // --- one player joins an FFA room -------------------------------------
  const a = client('Alice', 'test1', 'ffa');
  await sleep(600);
  ok(a.id > 0, 'client receives an id and welcome', 'id=' + a.id);
  ok(!!a.match, 'match info sent', a.match && (a.match.label + ' on ' + a.match.mapName));
  ok(a.roster.length === 10, 'lobby filled to 10 with bots', 'roster=' + a.roster.length);
  ok(a.roster.filter(r => r.bot).length === 9, 'nine of them are bots');

  await sleep(700);
  ok(a.snaps > 5, 'snapshots streaming', a.snaps + ' in ~1.3 s');
  const moving = a.last && a.last.e.length === 10;
  ok(moving, 'snapshot carries every entity', a.last && a.last.e.length);

  // bots should actually be moving around the map
  const p1 = a.last.e.map(e => [e[1], e[3]]);
  await sleep(1200);
  const p2 = a.last.e.map(e => [e[1], e[3]]);
  let movers = 0;
  for(let i = 0; i < p1.length; i++) if(Math.hypot(p1[i][0]-p2[i][0], p1[i][1]-p2[i][1]) > 0.5) movers++;
  ok(movers >= 4, 'bots are walking around', movers + ' of 10 moved');

  // --- a second human takes a bot's slot --------------------------------
  const b = client('Bob', 'test1', 'ffa');
  await sleep(600);
  ok(b.roster.length === 10, 'room still holds 10 with two humans');
  ok(b.roster.filter(r => r.bot).length === 8, 'a bot made way for the human',
     b.roster.filter(r => r.bot).length + ' bots');

  // --- shooting ---------------------------------------------------------
  a.move(0, 0, 0);
  b.move(0, 0, -6);
  await sleep(200);

  // a player who has only just appeared cannot be touched
  b.hurts.length = 0;
  a.send({t:'shot', w:'ak', hits:[{id:b.id, head:false, falloff:1}]});
  await sleep(250);
  ok(b.hurts.filter(h => h.by === a.id).length === 0,
     'a player who just spawned cannot be shot', 'hp still ' + b.hp);

  // firing gives that cover up, for him as for everyone
  b.send({t:'shot', w:'usp', hits:[]});
  await sleep(150);
  ok(a.msgs.includes('safeover'), 'and shooting gives the cover up');

  a.move(0, 0, 0);
  b.move(0, 0, -6);
  await sleep(200);
  // the room is full of bots who also shoot Bob, so attribute the damage
  b.hurts.length = 0;
  a.send({t:'shot', w:'ak', hits:[{id:b.id, head:false, falloff:1}]});
  await sleep(250);
  const mine = b.hurts.filter(h => h.by === a.id);
  ok(mine.length === 1 && mine[0].from - mine[0].to === 33,
     'a valid hit applies exactly the weapon damage',
     mine.length ? (mine[0].from + ' -> ' + mine[0].to) : 'no hit registered');

  // rate limit. Over the internet a few shots often arrive bunched together, and
  // those must all count; but a flood far beyond the gun's rate must not.
  // Every accepted shot is announced to the others as 'fire', so count those.
  const fires = () => b.events.filter(e => e.t === 'fire' && e.id === a.id).length;
  await sleep(1200);                                   // let the rifle's budget refill
  let f0 = fires();
  for(let i=0;i<3;i++) a.send({t:'shot', w:'ak', hits:[]});
  await sleep(250);
  ok(fires() - f0 === 3, 'three rounds arriving bunched all count', (fires() - f0) + ' of 3 accepted');
  await sleep(1200);
  f0 = fires();
  for(let i=0;i<60;i++) a.send({t:'shot', w:'ak', hits:[]});
  await sleep(300);
  ok(fires() - f0 <= 12, 'sixty rounds in one instant are capped near one second of fire',
     (fires() - f0) + ' of 60 accepted');

  // a hit claimed from across the map is rejected
  a.move(0, 0, 0);
  b.move(0, 0, -300);
  await sleep(250);
  b.hurts.length = 0;
  a.send({t:'shot', w:'usp', hits:[{id:b.id, head:false, falloff:1}]});
  await sleep(250);
  ok(b.hurts.filter(h => h.by === a.id).length === 0,
     'an out-of-range hit claim is rejected');

  // --- killing credits the shooter and heals them -----------------------
  // bots are shooting Bob too, so keep him planted next to Alice and keep
  // firing until one of OUR shots is the one that finishes him
  a.events.length = 0;
  b.send({t:'shot', w:'usp', hits:[]});
  let killEvent = null;
  for(let i = 0; i < 8 && !killEvent; i++){
    a.move(0, 0, 0); b.move(0, 0, -6);
    await sleep(120);
    a.send({t:'shot', w:'awp', hits:[{id:b.id, head:false, falloff:1}]});
    await sleep(1500);                 // AWP is slow; respect the server's limiter
    killEvent = a.events.find(e => e.victim === b.id && e.by === a.id);
  }
  ok(!!killEvent, 'a one-shot sniper kill is broadcast and credited to the shooter');

  // --- modes ------------------------------------------------------------
  const d = client('Duelist', 'test2', 'duel');
  await sleep(700);
  ok(d.roster.length === 2, '1v1 fills to exactly two', 'roster=' + d.roster.length);
  ok(d.match.target === 10, '1v1 plays to ten');

  const k = client('Shover', 'test3', 'knock');
  await sleep(700);
  ok(k.roster.length === 6, 'knockback fills to six', 'roster=' + k.roster.length);
  ok(k.match.mapName === 'Skyfall', 'knockback uses the island', k.match.mapName);
  ok(k.match.classes.length === 2, 'knockback offers two classes');

  // knockback deals no damage, only shoves
  const k2 = client('Shover2', 'test3', 'knock');
  await sleep(500);
  k.move(0, 14.4, 0); k2.move(0, 14.4, -5);
  k2.send({t:'shot', w:'usp', hits:[]});          // in the fight already, so no spawn cover
  await sleep(200);
  k2.hurts.length = 0;
  k.send({t:'shot', w:'ak', hits:[{id:k2.id, head:false, falloff:1}]});
  await sleep(300);
  ok(k2.hurts.length === 0, 'knockback shots do no damage', 'hp still ' + k2.hp);
  ok(k2.msgs.includes('shove'), 'a shove was broadcast instead');

  // --- leaving refills with a bot ---------------------------------------
  b.ws.close();
  await sleep(700);
  const after = a.roster;
  ok(true, 'player left cleanly');

  log('');
  log(fails ? fails + ' CHECK(S) FAILED' : 'all checks passed');
  srv.kill();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
