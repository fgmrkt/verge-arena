/* Verge — shared world module.
 *
 * Loaded by BOTH the browser client and the Node server so that every machine
 * generates byte-identical geometry from the same map id. The generators are
 * seeded, so no map data is ever sent over the wire: the server picks an index
 * and everyone builds the same city.
 *
 * Browser:  <script src="world.js"></script>  ->  window.VergeWorld
 * Node:     const World = require('./world.js');
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VergeWorld = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function B(x,y,z,w,h,d,c,ex){ const b={x:x,y:y,z:z,w:w,h:h,d:d,c:c||0}; if(ex) for(const k in ex) b[k]=ex[k]; return b; }
function mirror(list, out, ax, az){
  list.forEach(b=>{
    out.push(b);
    if(ax) out.push(B(-b.x,b.y,b.z,b.w,b.h,b.d,b.c));
    if(az) out.push(B(b.x,b.y,-b.z,b.w,b.h,b.d,b.c));
    if(ax&&az) out.push(B(-b.x,b.y,-b.z,b.w,b.h,b.d,b.c));
  });
}
function perimeter(out, half, h, c){
  out.push(B(0,0, half,half*2+4,h,2,c));
  out.push(B(0,0,-half,half*2+4,h,2,c));
  out.push(B( half,0,0,2,h,half*2,c));
  out.push(B(-half,0,0,2,h,half*2,c));
}
function stair(out,x,z,dir,steps,rise,run,width,c){
  for(let i=0;i<steps;i++){
    const off=(i+.5)*run;
    if(dir==='+z') out.push(B(x,0,z+off,width,rise*(steps-i),run,c));
    if(dir==='-z') out.push(B(x,0,z-off,width,rise*(steps-i),run,c));
    if(dir==='+x') out.push(B(x+off,0,z,run,rise*(steps-i),width,c));
    if(dir==='-x') out.push(B(x-off,0,z,run,rise*(steps-i),width,c));
  }
}

// a wall segment: solid, with a doorway, or with a window band
function wall(out, x, z, w, d, h, kind, c){
  const alongX = w > d;
  if(kind==='solid'){ out.push(B(x,0,z,w,h,d,c)); return; }
  if(kind==='door'){
    const len = alongX ? w : d, gap = 3.2, side = (len-gap)/2, off = gap/2 + side/2;
    if(alongX){
      out.push(B(x-off,0,z,side,h,d,c));
      out.push(B(x+off,0,z,side,h,d,c));
      out.push(B(x,2.5,z,gap,h-2.5,d,c));
    } else {
      out.push(B(x,0,z-off,w,h,side,c));
      out.push(B(x,0,z+off,w,h,side,c));
      out.push(B(x,2.5,z,w,h-2.5,gap,c));
    }
    return;
  }
  // window: sill, lintel, and a mullion down the middle — you can shoot through it
  out.push(B(x,0,z,w,1.15,d,c));
  out.push(B(x,2.35,z,w,h-2.35,d,c));
  if(alongX) out.push(B(x,1.15,z,0.9,1.2,d,c));
  else       out.push(B(x,1.15,z,w,1.2,0.9,c));
}
// kinds = [north, south, west, east]
function house(out, cx, cz, w, d, h, kinds, c, rc){
  const t = 0.7;
  wall(out, cx, cz-d/2, w, t, h, kinds[0], c);
  wall(out, cx, cz+d/2, w, t, h, kinds[1], c);
  wall(out, cx-w/2, cz, t, d, h, kinds[2], c);
  wall(out, cx+w/2, cz, t, d, h, kinds[3], c);
  out.push(B(cx, h, cz, w+1.4, 0.5, d+1.4, rc===undefined?3:rc));
}

function rng(seed){
  let x = (seed>>>0) || 7;
  return ()=>{ x ^= x<<13; x>>>=0; x ^= x>>>17; x ^= x<<5; x>>>=0; return x/4294967296; };
}
// exterior stair hugging a building's east face, one metre out so the roof overhang clears it
function roofStair(out, cx, cz, w, h, R){
  const rise = 0.36;
  const steps = Math.ceil((h+0.5)/rise), run = 0.62, len = steps*run;
  const x = cx + w/2 + 1.6;
  const dir = R()<.5 ? '+z' : '-z';
  const z0 = dir==='+z' ? cz - len/2 : cz + len/2;
  stair(out, x, z0, dir, steps, rise, run, 1.35, 0);
  return {x:x, z:(dir==='+z' ? z0+len/2 : z0-len/2), w:1.8, d:len+0.8};
}

function cityMap(o){
  const R = rng(o.seed);
  const s=[], half=o.half, block=o.block, buildings=[], lights=[];
  const NEON = [[1.00,0.18,0.42],[0.20,0.95,0.95],[1.00,0.62,0.10],[0.55,0.30,1.00],
                [0.25,1.00,0.45],[1.00,0.92,0.30],[1.00,0.35,0.85],[0.30,0.65,1.00]];
  const LAMP = [1.00,0.86,0.58];
  const neon = (x,y,z,w,h,d,c)=>s.push(D(x,y,z,w,h,d,3,{style:5, tint:c}));
  const emissive = (x,y,z,w,h,d,c)=>s.push(D(x,y,z,w,h,d,3,{style:6, tint:c}));
  // every placed object reserves its footprint; later objects have to find clear ground
  const taken = [], pendTree = [], hi = [];
  // same idea as the street reservations, but in 3D for anything mounted up high
  const hiFits = (x,z,w,d,y0,y1)=>!hi.some(r =>
    x-w/2 < r[2] && x+w/2 > r[0] && z-d/2 < r[3] && z+d/2 > r[1] && y0 < r[5] && y1 > r[4]);
  const hiClaim = (x,z,w,d,y0,y1)=>{ hi.push([x-w/2, z-d/2, x+w/2, z+d/2, y0, y1]); };
  const claim = (x,z,w,d)=>{ taken.push([x-w/2, z-d/2, x+w/2, z+d/2]); };
  const fits = (x,z,w,d,pad)=>{
    const p = pad||0;
    for(let i=0;i<taken.length;i++){
      const t = taken[i];
      if(x-w/2-p < t[2] && x+w/2+p > t[0] && z-d/2-p < t[3] && z+d/2+p > t[1]) return false;
    }
    return true;
  };
  const D = (x,y,z,w,h,d,c,ex)=>{ const b=B(x,y,z,w,h,d,c); b.deco=true; if(ex) for(const k in ex) b[k]=ex[k]; return b; };
  const pick = a=>a[(R()*a.length)|0];
  const WALL_TINTS = [[0.96,0.93,0.86],[0.90,0.84,0.72],[0.80,0.62,0.52],[0.78,0.78,0.78],[0.86,0.90,0.94],
                      [0.74,0.76,0.66],[0.98,0.98,0.96],[0.62,0.50,0.44],[0.88,0.80,0.70],[0.70,0.72,0.76]];
  const AWNINGS = [[0.72,0.18,0.18],[0.16,0.42,0.34],[0.90,0.74,0.28],[0.22,0.32,0.58],[0.92,0.90,0.84],[0.36,0.36,0.40]];
  const CARS = [[0.85,0.86,0.88],[0.12,0.13,0.15],[0.55,0.10,0.12],[0.16,0.26,0.48],[0.62,0.62,0.64],[0.78,0.66,0.30],[0.30,0.42,0.30]];
  function newBuilding(floors, forceStyle){
    const style = forceStyle || (floors>=3 && R()<.35 ? 3 : (R()<.4 ? 2 : 1));
    const b = {tint:pick(WALL_TINTS), style:style, winW:1.6+R()*1.2, dirt:R()*R(), hmax:floors*3.2, seed:R()*7};
    if(style===3){ b.tint=[0.80,0.84,0.88]; b.winW=1.3+R()*0.6; }
    buildings.push(b); return buildings.length-1;
  }
  const tag = (i0,bid)=>{ for(let i=i0;i<s.length;i++) if(s[i].bid===undefined) s[i].bid=bid; };

  // the walls around the district are buildings too, so the edge reads as more city
  const i0 = s.length; perimeter(s, half, 12.9, 0); tag(i0, newBuilding(4, 1));

  const span = half*2 - 6;
  let n = Math.max(2, Math.round((span + 5)/(block + 5)));
  let street = (span - n*block)/(n+1);
  if(street < 4.8){ n--; street = (span - n*block)/(n+1); }
  const pitch = block + street;
  const first = -span/2 + street + block/2;
  const inset = 1.2, w = block - inset*2, d = block - inset*2;
  const kinds = ()=>{ const r=R(); return r<.5?'door':(r<.85?'window':'solid'); };
  let stairsLeft = o.stairs;

  // ---- one building: ground floor you can enter, solid storeys above, roof life ----
  function building(cx, cz, bw, bd, floors, k, opts){
    const bid = newBuilding(floors);
    const st = buildings[bid].style;
    const i0 = s.length;
    house(s, cx, cz, bw, bd, 4.1, k, 0, 2);                  // enterable ground floor, dark ceiling slab
    let topY = 4.6, tw = bw+1.4, td = bd+1.4, tx = cx, tz = cz;
    let storeyTop = 4.6, storeyOut = 0.0;      // top of the block balconies can hang on, and how far it juts out
    if(floors > 1){
      const stepped = floors >= 3 && R() < .5;
      const h2 = stepped ? 7.3 : floors*3.2 + 0.9;
      storeyTop = h2; storeyOut = 0.45;                        // the storey block overhangs the ground floor
      s.push(B(cx, 4.6, cz, bw+0.9, h2-4.6, bd+0.9, 0));       // storeys
      s.push(B(cx, h2, cz, bw+1.4, 0.4, bd+1.4, 2));          // roof
      topY = h2+0.4; tw = bw+1.4; td = bd+1.4;
      if(stepped){
        const h3 = floors*3.2 + 0.9;
        const sw = bw-2.6, sd = bd-2.6;
        tx = cx + (R()-.5)*1.6; tz = cz + (R()-.5)*1.6;
        s.push(B(tx, topY, tz, sw, h3-topY, sd, 0));
        s.push(B(tx, h3, tz, sw+0.8, 0.4, sd+0.8, 2));
        // parapet on the lower roof
        s.push(D(cx, topY, cz-td/2+0.15, tw, 0.5, 0.3, 0));
        s.push(D(cx, topY, cz+td/2-0.15, tw, 0.5, 0.3, 0));
        s.push(D(cx-tw/2+0.15, topY, cz, 0.3, 0.5, td, 0));
        s.push(D(cx+tw/2-0.15, topY, cz, 0.3, 0.5, td, 0));
        topY = h3+0.4; tw = sw+0.8; td = sd+0.8;
      }
    }
    tag(i0, bid);
    // parapet
    s.push(D(tx, topY, tz-td/2+0.15, tw, 0.55, 0.3, 0, {bid:bid}));
    s.push(D(tx, topY, tz+td/2-0.15, tw, 0.55, 0.3, 0, {bid:bid}));
    s.push(D(tx-tw/2+0.15, topY, tz, 0.3, 0.55, td, 0, {bid:bid}));
    s.push(D(tx+tw/2-0.15, topY, tz, 0.3, 0.55, td, 0, {bid:bid}));
    // roof clutter
    const acs = 1 + (R()*3)|0;
    for(let a=0;a<acs;a++){
      const x=tx+(R()-.5)*(tw-3), z=tz+(R()-.5)*(td-3);
      if(!hiFits(x,z,1.6,1.6,topY,topY+0.8)) continue;
      hiClaim(x,z,1.6,1.6,topY,topY+0.8);
      s.push(D(x, topY, z, 1.0,0.7,1.0, 2));
    }
    if(R()<.45){
      const x=tx+(R()-.5)*(tw-4), z=tz+(R()-.5)*(td-4);
      if(hiFits(x,z,2.2,2.2,topY,topY+2.2)){
        hiClaim(x,z,2.2,2.2,topY,topY+2.2);
        s.push(D(x, topY, z, 1.5,0.5,1.5, 2));
        s.push(D(x, topY+0.5, z, 1.4,1.6,1.4, 3, {tint:[0.55,0.45,0.35]}));
      }
    }
    if(R()<.35){
      const x=tx+(R()-.5)*(tw-4), z=tz+(R()-.5)*(td-4);
      if(hiFits(x,z,3.0,3.4,topY,topY+2.4)){
        hiClaim(x,z,3.0,3.4,topY,topY+2.4);
        s.push(D(x, topY, z, 2.2,2.3,2.6, 0, {bid:bid}));
      }
    }
    for(let a=0, na=(R()*3)|0; a<na; a++){              // aerials
      const px = tx+(R()-.5)*(tw-2), pz = tz+(R()-.5)*(td-2);
      if(!hiFits(px,pz,0.9,0.9,topY,topY+3.2)) continue;
      hiClaim(px,pz,0.9,0.9,topY,topY+3.2);
      s.push(D(px, topY, pz, 0.07, 1.2+R()*1.8, 0.07, 2));
      if(R()<.5) s.push(D(px, topY+1.1, pz, 0.7, 0.06, 0.06, 2));
    }
    if(R()<.3){                                          // satellite dish
      const px = tx+(R()-.5)*(tw-3), pz = tz+(R()-.5)*(td-3);
      if(hiFits(px,pz,1.5,1.5,topY,topY+0.6)){
        hiClaim(px,pz,1.5,1.5,topY,topY+0.6);
        s.push(D(px, topY, pz, 0.9,0.35,0.9, 2));
        s.push(D(px, topY+0.35, pz, 1.1,0.12,1.1, 2, {ry:R()*0.9}));
      }
    }
    if(R()<.42){                                         // chimney
      const px = tx+(R()-.5)*(tw-3), pz = tz+(R()-.5)*(td-3);
      if(hiFits(px,pz,1.2,1.2,topY,topY+1.2)){
        hiClaim(px,pz,1.2,1.2,topY,topY+1.2);
        s.push(D(px, topY, pz, 0.7, 1.1, 0.7, 1));
      }
    }
    if(floors >= 3 && R()<.55){                          // rooftop letters
      const nc = pick(NEON), along = R()<.5;
      const lw = along?tw*0.6:0.4, ld = along?0.4:td*0.6;
      if(hiFits(tx,tz,lw+0.4,ld+0.4,topY,topY+2.1)){
        hiClaim(tx,tz,lw+0.4,ld+0.4,topY,topY+2.1);
        s.push(D(tx, topY, tz, along?tw*0.6:0.2, 0.9, along?0.2:td*0.6, 2));
        neon(tx, topY+0.9, tz, along?tw*0.6:0.12, 1.1, along?0.12:td*0.6, nc);
      }
    }
    // downpipe on a corner
    s.push(D(cx + (R()<.5?-1:1)*(bw/2+0.45), 0, cz + (R()<.5?-1:1)*(bd/2-0.6), 0.16, 4.1, 0.16, 2));
    // awnings and signs over doors; balconies upstairs
    const faces = [[0,0,-1],[1,0,1],[2,-1,0],[3,1,0]];
    faces.forEach(([fi,dx,dz])=>{
      const fx = cx + dx*(bw/2+0.35), fz = cz + dz*(bd/2+0.35);
      if(k[fi]==='door'){
        const col = pick(AWNINGS);
        const aw = dx?1.35:3.9, ad = dz?1.35:3.9;
        if(hiFits(fx + dx*0.60, fz + dz*0.60, aw, ad, 2.55, 2.85)){
          hiClaim(fx + dx*0.60, fz + dz*0.60, aw, ad, 2.55, 2.85);
          s.push(D(fx + dx*0.60, 2.62, fz + dz*0.60, aw, 0.14, ad, 3, {tint:col}));
        }
        if(R()<.78 && hiFits(fx + dx*0.10, fz + dz*0.10, dx?0.4:3.0, dz?0.4:3.0, 3.25, 3.90)){
          const nc = pick(NEON);                        // lit fascia sign over the shopfront
          hiClaim(fx + dx*0.10, fz + dz*0.10, dx?0.4:3.0, dz?0.4:3.0, 3.25, 3.90);
          neon(fx + dx*0.10, 3.32, fz + dz*0.10, dx?0.10:3.0, 0.52, dz?0.10:3.0, nc);
          lights.push({x:fx + dx*1.4, z:fz + dz*1.4, r:6, c:[nc[0]*0.45, nc[1]*0.45, nc[2]*0.45]});
        }
        if(R()<.42 && hiFits(fx + dx*1.0, fz + dz*1.0, dx?2.0:1.2, dz?2.0:1.2, 2.80, 4.10)){
          const nc = pick(NEON), out = 1.58;            // the awning only reaches 1.275
          hiClaim(fx + dx*1.0, fz + dz*1.0, dx?2.0:1.2, dz?2.0:1.2, 2.80, 4.10);
          s.push(D(fx + dx*(out*0.5), 4.02, fz + dz*(out*0.5), dx?out:0.05, 0.05, dz?out:0.05, 2));
          s.push(D(fx + dx*0.06, 3.60, fz + dz*0.06, dx?0.10:0.10, 0.48, dz?0.10:0.10, 2));
          neon(fx + dx*out, 2.86, fz + dz*out, dx?0.10:0.95, 1.16, dz?0.10:0.95, nc);
        }
        [-1,1].forEach(sg=>{                            // sconces either side of the doorway
          const px = fx + (dx?0:sg*2.1), pz = fz + (dx?sg*2.1:0);
          emissive(px + dx*0.04, 2.35, pz + dz*0.04, dx?0.12:0.22, 0.26, dz?0.12:0.22, LAMP);
        });
      }
      if(floors > 1 && st !== 3){
        for(let f=2; f<=floors; f++){
          const y = 4.6 + (f-2)*3.2 - (f===2?0:0.1);
          if(y + 1.05 > storeyTop) break;      // above here the wall is set back or gone: nothing to hang from
          if(R() > .45) continue;
          const along = (dx?bd:bw) - 4;
          const off = (R()-.5)*along;
          // the storey face sits 0.10 beyond fz, so 0.58 puts the slab's inner edge just inside it
          const reach = 0.58;
          const px = fx + dx*reach + (dz?off:0), pz = fz + dz*reach + (dx?off:0);
          s.push(D(px, y, pz, dx?1.0:2.4, 0.16, dz?1.0:2.4, 1));
          s.push(D(px + dx*0.47, y+0.16, pz + dz*0.47, dx?0.06:2.4, 0.85, dz?0.06:2.4, 2));
        }
      }
    });
    if(opts && opts.stair){
      const f = roofStair(s, cx, cz, bw, 4.1, R);
      claim(f.x, f.z, f.w, f.d);                          // the stair owns its patch of street
    }
    // the shell plus room for the roof overhang, awnings, balconies and downpipe
    claim(cx, cz, bw+2.0, bd+2.0);   // overhang and downpipe only; awnings clear a car's roof
  }

  for(let i=0;i<n;i++) for(let j=0;j<n;j++){
    const cx = first + i*pitch, cz = first + j*pitch;
    const r = R();
    const centre = (n%2===1) && i===(n-1)/2 && j===(n-1)/2;
    if(centre || r < o.lots){
      s.push(B(cx,0,cz, w*0.42,0.9,w*0.42, 1));
      s.push(B(cx,0.9,cz, w*0.2,1.4,w*0.2, 2));
      s.push(B(cx-w*0.36,0,cz+w*0.36, 2.4,0.9,0.8, 1));
      s.push(B(cx+w*0.36,0,cz-w*0.36, 2.4,0.9,0.8, 1));
      s.push(B(cx+w*0.36,0,cz+w*0.36, 0.8,0.9,2.4, 1));
      claim(cx, cz, w*0.55, w*0.55);
      for(let t=0;t<3;t++) pendTree.push([cx+(R()-.5)*w*.7, cz+(R()-.5)*w*.7]);
      continue;
    }
    const canSplit = block >= 14 && r > o.lots + o.single;
    if(!canSplit){
      // a stair only makes sense onto a single-storey roof, so when the district still
      // owes stairs we force this block to one floor rather than hoping the dice agree
      const addStair = stairsLeft > 0 && i < n-1 && R() < .45;
      const floors = addStair ? 1 : pick(o.floors);
      const k = [kinds(),kinds(),kinds(),kinds()];
      if(!k.includes('door')) k[(R()*4)|0] = 'door';
      if(addStair){ k[3]='window'; stairsLeft--; }
      building(cx, cz, w, d, floors, k, {stair:addStair});
      if(w > 9) s.push(B(cx+(R()-.5)*w*.4, 0, cz+(R()-.5)*d*.4, 2.2,1.1,2.2, 1));   // counter, indoors
    } else {
      const alley = 2.8, alongX = R()<.5;
      if(alongX){
        const dw = (w-alley)/2;
        [-1,1].forEach((sg,idx)=>{
          const k = [kinds(),kinds(),kinds(),kinds()]; k[idx===0?3:2] = 'door';
          building(cx+sg*(dw/2+alley/2), cz, dw, d, pick(o.floors), k);
        });
        s.push(B(cx,0,cz+d*0.32, 1.7,1.3,1.1, 3, {tint:[0.15,0.35,0.22]}));
        claim(cx, cz+d*0.32, 2.3, 1.7);
      } else {
        const dd = (d-alley)/2;
        [-1,1].forEach((sg,idx)=>{
          const k = [kinds(),kinds(),kinds(),kinds()]; k[idx===0?1:0] = 'door';
          building(cx, cz+sg*(dd/2+alley/2), w, dd, pick(o.floors), k);
        });
        s.push(B(cx+w*0.32,0,cz, 1.1,1.3,1.7, 3, {tint:[0.15,0.35,0.22]}));
        claim(cx+w*0.32, cz, 1.7, 2.3);
      }
    }
    // trees on the sidewalk of some blocks
    if(R()<.5){
      const side = pick([[0,-1],[0,1],[-1,0],[1,0]]);
      for(let t=0;t<2;t++){
        const along = (t-0.5)*block*0.45;
        pendTree.push([cx + side[0]*(block/2+1.5) + (side[1]?along:0),
                       cz + side[1]*(block/2+1.5) + (side[0]?along:0)]);
      }
    }
  }
  const TREE_FOOT = 2.9;   // 3.2 left no kerb wide enough and wiped out every tree
  // the reservation list only knows what reserved itself, so test the crown against real
  // geometry too: it reaches up to 4 m and can meet an overhang the ground plan never saw
  const crownClear = (x,z)=>{
    const hw = 1.2;    // the widest crown half-extent is 1.09; a little margin on top
    for(let i=0;i<s.length;i++){
      const b = s[i];
      if(b.c === 4) continue;                       // other foliage is fine
      if(b.y > 4.0 || b.y + b.h < 0.9) continue;
      if(x-hw < b.x+b.w/2 && x+hw > b.x-b.w/2 && z-hw < b.z+b.d/2 && z+hw > b.z-b.d/2) return false;
    }
    return true;
  };
  pendTree.forEach(([x,z])=>{
    if(fits(x, z, TREE_FOOT, TREE_FOOT, 0.15) && crownClear(x, z)){
      claim(x, z, TREE_FOOT, TREE_FOOT); tree(x, z);
    }
  });
  // crown capped at sc 0.95 -> tallest point 3.85 m, which clears the 4.1 m roof line,
  // and no wider than TREE_FOOT so the reserved footprint actually matches the canopy
  function tree(x,z){
    const sc = 0.70+R()*0.25, g = 0.85+R()*0.3;
    s.push(B(x,0,z, 0.26,2.1*sc,0.26, 3, {tint:[0.40,0.28,0.18]}));   // trunk is solid; the crown is not
    s.push(D(x,1.95*sc,z, 2.3*sc,1.85*sc,2.3*sc, 4, {tint:[g,g,g], ry:R()*0.8}));
    s.push(D(x+(R()-.5)*0.45, 2.62*sc, z+(R()-.5)*0.45, 1.5*sc,1.25*sc,1.5*sc, 4, {tint:[g*1.08,g*1.08,g*1.0], ry:R()*0.8}));
  }
  // lamp posts on alternating intersection corners
  for(let i=0;i<=n;i++) for(let j=0;j<=n;j++){
    if((i+j)%2) continue;
    const x = first - block/2 - street/2 + i*pitch, z = first - block/2 - street/2 + j*pitch;
    const sx = (i%2?1:-1)*(street/2-0.5), sz = (j%2?1:-1)*(street/2-0.5);
    if(!fits(x+sx, z+sz, 1.4, 1.4, 0.1)) continue;
    claim(x+sx, z+sz, 1.4, 1.4);
    s.push(D(x+sx, 0, z+sz, 0.14,5.4,0.14, 2));
    s.push(D(x+sx-0.45*Math.sign(sx), 5.2, z+sz, 0.9,0.1,0.12, 2));
    emissive(x+sx-0.8*Math.sign(sx), 5.05, z+sz, 0.5,0.18,0.28, LAMP);
    lights.push({x:x+sx-0.8*Math.sign(sx), z:z+sz, r:11, c:[0.80,0.69,0.46]});
    if(R()<.4) s.push(D(x+sx*0.7, 0, z+sz*0.7, 0.3,0.75,0.3, 3, {tint:[0.75,0.15,0.12]}));
    if(R()<.45 && fits(x-sx, z-sz, 1.0, 1.0, 0.25)){     // traffic signal opposite
      claim(x-sx, z-sz, 1.0, 1.0);
      s.push(D(x-sx, 0, z-sz, 0.16,3.4,0.16, 2));
      s.push(D(x-sx, 3.4, z-sz, 0.34,0.92,0.30, 2));
      const on = (R()*3)|0;
      [[0.62,[1.0,0.16,0.16]],[0.34,[1.0,0.78,0.15]],[0.06,[0.20,1.0,0.35]]].forEach((L,li)=>{
        if(li===on) emissive(x-sx, 3.4+L[0], z-sz-0.16, 0.18,0.18,0.05, L[1]);
        else s.push(D(x-sx, 3.4+L[0], z-sz-0.16, 0.18,0.18,0.05, 2));
      });
    }
  }
  // parked cars: a collider for the body, cabin glass and wheels as dressing
  for(let c=0;c<o.cars;c++){
    let x=0, z=0, alongX=false, placed=false;
    for(let tryN=0; tryN<60 && !placed; tryN++){
      const i = (R()*n)|0, j = (R()*(n-1))|0;
      alongX = R()<.5;
      const lane = first + j*pitch + block/2 + street/2;
      const at   = first + i*pitch + (R()-.5)*block*0.6;
      const side = (R()<.5?-1:1) * (street/2 - 1.25);
      x = alongX?at:lane+side; z = alongX?lane+side:at;
      if(fits(x, z, alongX?4.4:1.9, alongX?1.9:4.4, 0.35)) placed = true;
    }
    if(!placed) continue;                              // no room on any kerb: skip this car
    const col = pick(CARS);
    const L = alongX?4.4:1.9, Wd = alongX?1.9:4.4;
    // reserve a wide strip across the street: two cars parked opposite each other left a
    // 0.80 m gap, and the player is 0.84 m wide, so the road was simply sealed
    claim(x, z, L + (alongX ? 0.35 : 2.6), Wd + (alongX ? 2.6 : 0.35));
    s.push(B(x, 0.32, z, L, 1.0, Wd, 3, {tint:col}));
    s.push(D(x + (alongX?0.2:0), 1.28, z + (alongX?0:0.2), alongX?2.3:1.72, 0.58, alongX?1.72:2.3, 5));
    [[-1.45,-0.78],[-1.45,0.78],[1.45,-0.78],[1.45,0.78]].forEach(([a,b])=>{
      s.push(D(x + (alongX?a:b), 0, z + (alongX?b:a), alongX?0.66:0.30, 0.64, alongX?0.30:0.66, 2));
    });
    // a lamp at each corner of each end: one sign drove both the end and the side before,
    // which put a single light diagonally opposite another instead of a pair per end
    [-1,1].forEach(end=>{
      [-1,1].forEach(side=>{
        const lx = x + (alongX ? 2.20*end : 0.62*side);
        const lz = z + (alongX ? 0.62*side : 2.20*end);
        const col = end > 0 ? [1.00,0.94,0.78] : [0.95,0.12,0.10];   // headlights one end, tails the other
        emissive(lx, 0.72, lz, alongX?0.06:0.34, 0.14, alongX?0.34:0.06, col);
      });
    });
  }
  for(let c=0;c<o.crates;c++){
    let x=0, z=0, placed=false;
    for(let tryN=0; tryN<20 && !placed; tryN++){
      const i = (R()*n)|0, j = (R()*(n-1))|0, alongX = R()<.5;
      const lane = first + j*pitch + block/2 + street/2;
      const at   = first + i*pitch + (R()-.5)*block*0.6;
      const side = (R()<.5?-1:1) * (street/2 - 0.9);
      x = alongX?at:lane+side; z = alongX?lane+side:at;
      if(fits(x, z, 1.5, 1.5, 0.5)) placed = true;
    }
    if(!placed) continue;
    claim(x, z, 2.0, 2.0);
    s.push(B(x, 0, z, 1.5,1.2,1.5, 3, {tint:[0.62,0.50,0.34], ry:R()*0.6}));
  }
  // skyline past the walls: more of the same city fading out
  for(let i=0;i<46;i++){
    const a = i/46*Math.PI*2 + R()*0.1, rr = half + 18 + R()*30;
    const fl = 2 + (R()*5)|0, bw = 7 + R()*9;
    const bid = newBuilding(fl, R()<.4?3:(R()<.5?2:1));
    s.push(D(Math.cos(a)*rr, -1, Math.sin(a)*rr, bw, fl*3.2+1.5, bw, 0, {bid:bid}));
    s.push(D(Math.cos(a)*rr, fl*3.2+0.5, Math.sin(a)*rr, bw+0.6, 0.4, bw+0.6, 2));
  }
  return {name:o.name, half:half, sky:o.sky, skyTop:o.skyTop, skyBot:o.skyBot, ground:o.ground,
          fogNear:o.fogNear, boxes:s, buildings:buildings, spawns:[], lights:lights,
          grid:{first:first, pitch:pitch, block:block, n:n, inset:inset},
          palette:[0xd6d2c9, 0xc8c2b6, 0x363b42, 0xffffff, 0x527d3c, 0x8ea7b6]};
}

// the knockback arena: a real island — grass on top, dirt under it, rock all the way down
function arenaMap(){
  const s = [], lights = [], buildings = [];
  const TOP = 14, R = 27, cell = 4.5;
  const rnd = rng(9331);
  const D = (x,y,z,w,h,d,c,ex)=>{ const b=B(x,y,z,w,h,d,c,ex); b.deco=true; return b; };
  const taken = [];
  const clear = (x,z,r)=>{
    for(let i=0;i<taken.length;i++){
      const t = taken[i];
      if(Math.hypot(x-t[0], z-t[1]) < r + t[2]) return false;
    }
    return true;
  };
  const claim = (x,z,r)=>taken.push([x,z,r]);

  // --- surface lattice, clipped to a wobbling circle so the coastline is irregular
  const key = (i,j)=>i+','+j;
  const have = new Set(), cells = [];
  const n = Math.ceil(R/cell)+1;
  for(let i=-n;i<=n;i++) for(let j=-n;j<=n;j++){
    const x = i*cell, z = j*cell, d = Math.hypot(x,z), a = Math.atan2(z,x);
    const wob = Math.sin(a*3.0)*2.4 + Math.cos(a*5.0)*1.7 + Math.sin(a*8.0)*0.9;
    if(d <= R + wob){ have.add(key(i,j)); cells.push([i,j,x,z,d]); }
  }
  cells.forEach(([i,j,x,z,d])=>{
    const v = rnd();
    const g = 0.30 + v*0.12;                                   // grass, patchy
    s.push(B(x, TOP-1.0, z, cell+0.06, 1.0, cell+0.06, 0, {tint:[g*0.70, g*1.35, g*0.52]}));
    const e = 0.40 + rnd()*0.10;                               // dirt directly beneath
    s.push(D(x, TOP-3.6, z, cell+0.03, 2.6, cell+0.03, 1, {tint:[e, e*0.72, e*0.48]}));
  });
  // exposed coastline: bare earth on any side where the island simply stops
  cells.forEach(([i,j,x,z])=>{
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([di,dj])=>{
      if(have.has(key(i+di,j+dj))) return;
      const e = 0.46 + rnd()*0.10;
      s.push(D(x + di*cell*0.46, TOP-0.55, z + dj*cell*0.46,
               di?0.7:cell+0.06, 1.1, dj?0.7:cell+0.06, 1, {tint:[e, e*0.74, e*0.50]}));
      // a faint warm lip so the drop is still readable after dark
      s.push(D(x + di*cell*0.5, TOP-0.02, z + dj*cell*0.5,
               di?0.35:cell+0.06, 0.1, dj?0.35:cell+0.06, 3, {style:6, tint:[0.95,0.86,0.62]}));
    });
  });

  // --- rock beneath the soil, octagonal layers tapering to a point
  let y = TOP-3.6;
  [[0.94,3.0],[0.83,3.2],[0.68,3.4],[0.50,3.6],[0.31,4.0],[0.13,5.2]].forEach(([f,h],L)=>{
    y -= h;
    const rr = R*f, t = 0.42 - L*0.045;
    s.push(D(0, y, 0, rr*2, h, rr*2, 1, {tint:[t+0.06,t*0.94,t*0.84]}));
    s.push(D(0, y, 0, rr*1.9, h, rr*1.9, 1, {tint:[t+0.02,t*0.88,t*0.78], ry:Math.PI/4}));
  });
  for(let k=0;k<16;k++){                                       // roots and stone hanging below
    const a = rnd()*Math.PI*2, rr = R*(0.30+rnd()*0.55), len = 3+rnd()*8;
    s.push(D(Math.cos(a)*rr, TOP-6.5-len, Math.sin(a)*rr, 1.5+rnd()*1.7, len, 1.5+rnd()*1.7, 1,
             {tint:[0.34,0.27,0.21], ry:rnd()*1.5}));
  }
  for(let k=0;k<10;k++){                                       // smaller islets drifting alongside
    const a = rnd()*Math.PI*2, rr = R*(1.35+rnd()*0.9), sz = 2+rnd()*5;
    s.push(D(Math.cos(a)*rr, TOP-7-rnd()*16, Math.sin(a)*rr, sz, sz*0.55, sz, 1, {tint:[0.40,0.33,0.26], ry:rnd()*1.5}));
    s.push(D(Math.cos(a)*rr, TOP-7-rnd()*0.001, Math.sin(a)*rr, sz*0.9, 0.5, sz*0.9, 4, {tint:[0.42,0.62,0.30]}));
  }

  // --- cover, claimed first so the planting avoids it
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([a,b])=>{
    s.push(B(a*13, TOP, b*13, 1.8, 4.6, 1.8, 2, {tint:[0.52,0.50,0.46]}));   // standing stones
    s.push(D(a*13, TOP+4.6, b*13, 2.6, 0.5, 2.6, 1, {tint:[0.46,0.44,0.40]}));
    claim(a*13, b*13, 2.4);
    s.push(B(a*8.5, TOP, b*19, 4.4, 1.2, 1.2, 1, {tint:[0.56,0.52,0.45]}));  // fallen logs and rocks
    claim(a*8.5, b*19, 2.8);
    s.push(B(a*20, TOP, b*6, 1.2, 1.9, 5.0, 1, {tint:[0.50,0.47,0.42]}));
    claim(a*20, b*6, 3.0);
    s.push(B(a*6.2, TOP, b*6.2, 1.6, 1.6, 1.6, 1, {tint:[0.54,0.51,0.45]}));   // clear of the outcrop
    claim(a*6.2, b*6.2, 1.8);
  });
  s.push(B(0, TOP, 0, 8, 1.0, 8, 1, {tint:[0.58,0.55,0.48]}));               // centre outcrop
  s.push(D(0, TOP+1.0, 0, 7.2, 0.25, 7.2, 4, {tint:[0.36,0.58,0.26]}));
  claim(0, 0, 5.5);
  lights.push({x:0, z:0, r:16, c:[0.35,0.42,0.22]});
  const spawns = [];
  for(let i=0;i<8;i++){
    const a = i/8*Math.PI*2;
    const sx = Math.cos(a)*(R-6), sz = Math.sin(a)*(R-6);
    spawns.push([sx, sz]); claim(sx, sz, 2.6);
  }

  // --- planting: trees, bushes, boulders and grass tufts on clear ground
  cells.forEach(([i,j,x,z,d])=>{
    if(d > R-3.5) return;
    const px = x + (rnd()-0.5)*cell*0.7, pz = z + (rnd()-0.5)*cell*0.7;
    const roll = rnd();
    if(roll < 0.12 && clear(px,pz,2.6)){                        // tree
      claim(px,pz,2.6);
      const sc = 0.75 + rnd()*0.3, g2 = 0.34 + rnd()*0.12;
      s.push(B(px, TOP, pz, 0.30, 2.3*sc, 0.30, 1, {tint:[0.32,0.23,0.16]}));
      s.push(D(px, TOP+2.1*sc, pz, 2.6*sc, 2.0*sc, 2.6*sc, 4, {tint:[g2*0.75,g2*1.5,g2*0.6], ry:rnd()}));
      s.push(D(px+(rnd()-.5)*0.5, TOP+3.3*sc, pz+(rnd()-.5)*0.5, 1.7*sc, 1.4*sc, 1.7*sc, 4,
               {tint:[g2*0.85,g2*1.62,g2*0.66], ry:rnd()}));
    } else if(roll < 0.26 && clear(px,pz,1.3)){                 // bush
      claim(px,pz,1.3);
      const g3 = 0.30 + rnd()*0.12;
      s.push(D(px, TOP, pz, 1.5+rnd()*0.7, 0.9+rnd()*0.5, 1.5+rnd()*0.7, 4,
               {tint:[g3*0.78,g3*1.45,g3*0.58], ry:rnd()}));
    } else if(roll < 0.36 && clear(px,pz,1.4)){                 // boulder
      claim(px,pz,1.4);
      const r2 = 0.46+rnd()*0.10, sz = 1.1+rnd()*1.1;
      s.push(B(px, TOP, pz, sz, sz*0.8, sz, 1, {tint:[r2,r2*0.96,r2*0.9], ry:rnd()}));
    } else if(roll < 0.72){                                     // grass tufts, no collision
      for(let t=0;t<2;t++){
        const tx = x+(rnd()-.5)*cell*0.8, tz = z+(rnd()-.5)*cell*0.8;
        if(!clear(tx,tz,0.9)) continue;                         // don't grow inside a rock
        const g4 = 0.32 + rnd()*0.14;
        s.push(D(tx, TOP, tz, 0.5+rnd()*0.5, 0.3+rnd()*0.3, 0.5+rnd()*0.5, 4,
                 {tint:[g4*0.8,g4*1.5,g4*0.6], ry:rnd()}));
      }
    }
  });

  return {name:'Skyfall', half:60, fogNear:30, boxes:s, buildings:buildings, spawns:spawns, lights:lights,
          grid:{first:0, pitch:1, block:1, n:0, inset:0}, ground:0x2a2f36,
          voidBelow:true, navY:TOP+0.05, spawnY:TOP+0.4,
          palette:[0x8fbf6a, 0xb9a487, 0x6e6a63, 0xffffff, 0x63a844, 0x8ea7b6]};
}
const ARENA = arenaMap();

// tight maps for duels: two blocks a side, narrow streets, nowhere to hide for long
const DUELS = [
  cityMap({name:'The Yard', seed:3301, half:22, block:10, floors:[1,1,2], lots:.10, single:1, stairs:2, cars:3, crates:4,
           sky:0xd6dee4, skyTop:0x6f98b8, skyBot:0xe4e8ea, ground:0xcfcac0, fogNear:12}),
  cityMap({name:'Backlot',  seed:7714, half:20, block:9,  floors:[1,2],    lots:.08, single:1, stairs:2, cars:2, crates:5,
           sky:0xd9dee6, skyTop:0x5f748a, skyBot:0xe6eaee, ground:0xd2d4d8, fogNear:12}),
  cityMap({name:'The Cut',  seed:5126, half:21, block:11, floors:[1,1,2],  lots:.12, single:1, stairs:2, cars:3, crates:4,
           sky:0xe2d8c3, skyTop:0x8fb2c8, skyBot:0xeee3cc, ground:0xd6ccb4, fogNear:12})
];
const MAPS = [
  cityMap({name:'Old Town', seed:1971, half:40, block:12, floors:[1,1,2,2,2,3], lots:.06, single:1,   stairs:4, cars:7,  crates:6,
           sky:0xd6dee4, skyTop:0x6f98b8, skyBot:0xe4e8ea, ground:0xcfcac0, fogNear:18}),
  cityMap({name:'Midtown', seed:4402, half:46, block:15, floors:[1,2,2,3,3,4],   lots:.10, single:.42, stairs:3, cars:11, crates:8,
           sky:0xd9dee6, skyTop:0x5f748a, skyBot:0xe6eaee, ground:0xd2d4d8, fogNear:20}),
  cityMap({name:'Harbor', seed:8123, half:44, block:14, floors:[1,1,2,2,3],     lots:.14, single:.45, stairs:4, cars:9,  crates:8,
           sky:0xe2d8c3, skyTop:0x8fb2c8, skyBot:0xeee3cc, ground:0xd6ccb4, fogNear:22})
];

// ---------------------------------------------------------------------------
// Collision + queries, all taking an explicit world so the server can hold many
// ---------------------------------------------------------------------------
function solidsOf(def){
  const out = [];
  for(let i=0;i<def.boxes.length;i++){
    const b = def.boxes[i];
    if(b.deco) continue;
    out.push({mx:b.x-b.w/2, my:b.y, mz:b.z-b.d/2,
              Mx:b.x+b.w/2, My:b.y+b.h, Mz:b.z+b.d/2});
  }
  return out;
}
function overlaps(mx,my,mz,Mx,My,Mz,b){
  return mx<b.Mx && Mx>b.mx && my<b.My && My>b.my && mz<b.Mz && Mz>b.mz;
}
function freeAt(solids,x,y,z,r,h){
  const mx=x-r,Mx=x+r,my=y,My=y+h,mz=z-r,Mz=z+r;
  for(let i=0;i<solids.length;i++) if(overlaps(mx,my,mz,Mx,My,Mz,solids[i])) return false;
  return true;
}
const EPS = 1e-6;
function rayBox(ox,oy,oz,dx,dy,dz,b){
  const ix=1/(Math.abs(dx)<EPS?EPS:dx), iy=1/(Math.abs(dy)<EPS?EPS:dy), iz=1/(Math.abs(dz)<EPS?EPS:dz);
  let t1=(b.mx-ox)*ix, t2=(b.Mx-ox)*ix;
  let tmin=Math.min(t1,t2), tmax=Math.max(t1,t2);
  t1=(b.my-oy)*iy; t2=(b.My-oy)*iy;
  tmin=Math.max(tmin,Math.min(t1,t2)); tmax=Math.min(tmax,Math.max(t1,t2));
  t1=(b.mz-oz)*iz; t2=(b.Mz-oz)*iz;
  tmin=Math.max(tmin,Math.min(t1,t2)); tmax=Math.min(tmax,Math.max(t1,t2));
  if(tmax<0 || tmin>tmax) return -1;
  return tmin>0?tmin:-1;
}
// nearest solid hit along a ray, or -1
function raycast(w, ox,oy,oz, dx,dy,dz, maxT){
  let best = maxT;
  const S = w.solids;
  for(let i=0;i<S.length;i++){
    const t = rayBox(ox,oy,oz,dx,dy,dz,S[i]);
    if(t>0 && t<best) best = t;
  }
  if(w.hasGround && dy < -EPS){
    const t = -oy/dy;
    if(t>0 && t<best){
      const px=ox+dx*t, pz=oz+dz*t;
      if(Math.abs(px)<w.half+2 && Math.abs(pz)<w.half+2) best = t;
    }
  }
  return best < maxT ? best : -1;
}
function navPoints(w){
  const out = [], step = 3, lim = w.half-3, ny = w.navY;
  for(let x=-lim;x<=lim;x+=step) for(let z=-lim;z<=lim;z+=step){
    if(!freeAt(w.solids,x,ny,z,0.55,1.7)) continue;
    if(!w.hasGround && freeAt(w.solids,x,ny-0.5,z,0.35,0.4)) continue;   // nothing under it
    out.push({x:x, y:ny-0.05, z:z});
  }
  return out;
}
function spreadSpawns(w, count){
  if(w.def.spawns && w.def.spawns.length) return w.def.spawns.slice();
  const nav = w.nav;
  if(!nav.length) return [[0,0]];
  const picked = [nav[0]];
  while(picked.length < count && picked.length < nav.length){
    let best=null, bd=-1;
    for(let i=0;i<nav.length;i++){
      const p = nav[i];
      let d = 1e9;
      for(let k=0;k<picked.length;k++){
        const q = picked[k], dd = (p.x-q.x)*(p.x-q.x) + (p.z-q.z)*(p.z-q.z);
        if(dd < d) d = dd;
      }
      if(d > bd){ bd = d; best = p; }
    }
    picked.push(best);
  }
  return picked.map(p=>[p.x, p.z]);
}

// ---------------------------------------------------------------------------
// Map pools. Index into these is all that travels over the network.
// ---------------------------------------------------------------------------
const POOLS = { ffa: MAPS, duel: DUELS, knock: [ARENA] };

function build(kind, index){
  const pool = POOLS[kind] || POOLS.ffa;
  const def = pool[((index|0) % pool.length + pool.length) % pool.length];
  const w = {
    def: def,
    name: def.name,
    half: def.half,
    solids: solidsOf(def),
    hasGround: !def.voidBelow,
    navY: def.navY || 0.05,
    spawnY: def.spawnY || 0
  };
  w.nav = navPoints(w);
  w.spawns = spreadSpawns(w, 10);
  return w;
}

return {
  build: build,
  pool: function(kind){ return (POOLS[kind] || POOLS.ffa).slice(); },
  poolSize: function(kind){ return (POOLS[kind] || POOLS.ffa).length; },
  names: function(kind){ return (POOLS[kind] || POOLS.ffa).map(d=>d.name); },
  solidsOf: solidsOf, freeAt: freeAt, raycast: raycast, rayBox: rayBox,
  overlaps: overlaps, navPoints: navPoints
};
}));
