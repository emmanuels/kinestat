/* KinéStat v1 — mesure d'angles sur photo, données locales (IndexedDB) */
(function(){
"use strict";
const VERSION = "1.0.0";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));

/* ================= Catalogue des tests : chargé depuis tests.json ================= */
// Valeur clinique = a × ABC + b (voir tests.json, source de vérité partagée avec la future version native).
let TESTS = {}, GROUPS = [];
const FALLBACK_TEST = {name:"Mesure libre (3 points)",short:"Libre",pos:"Angle quelconque entre trois repères, sommet en B.",labels:{A:"Point A",B:"Sommet B",C:"Point C"},clin:null};
async function loadCatalogue(){
  const r = await fetch("tests.json",{cache:"no-cache"});
  if(!r.ok) throw new Error("tests.json "+r.status);
  const doc = await r.json();
  TESTS = {};
  for(const [id,t] of Object.entries(doc.tests)){
    const c = t.clinical;
    TESTS[id] = {name:t.name,short:t.short,pos:t.position,labels:t.landmarks,
      clin: c ? {label:c.label,a:c.a,b:c.b,fn:(x => c.a*x+c.b)} : null};
  }
  GROUPS = doc.groups.map(g => [g.name,g.tests.filter(id => TESTS[id])]);
  if(!TESTS.libre) TESTS.libre = FALLBACK_TEST;
}
const KEYS = ["A","B","C"];
const COLORS = {A:"#e08a00",B:"#1d8fb3",C:"#c0367f"};

/* ================= Stockage local : IndexedDB, repli en mémoire ================= */
const store = (() => {
  let memState = null, dbp = null;
  const memPhotos = new Map();
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej) => {
      try{
        const r = indexedDB.open("kinestat",1);
        r.onupgradeneeded = () => { const db = r.result; db.createObjectStore("kv"); db.createObjectStore("photos"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }catch(e){ rej(e); }
    });
    return dbp;
  }
  function tx(name,mode,fn){
    return open().then(db => new Promise((res,rej) => {
      const t = db.transaction(name,mode); let out;
      const q = fn(t.objectStore(name));
      if(q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  return {
    async getState(){ try{ return await tx("kv","readonly",s => s.get("state")); }catch(e){ return memState; } },
    async setState(v){ memState = v; try{ await tx("kv","readwrite",s => { s.put(v,"state"); }); return true; }catch(e){ return false; } },
    async getPhoto(id){ try{ const b = await tx("photos","readonly",s => s.get(id)); return b || memPhotos.get(id) || null; }catch(e){ return memPhotos.get(id) || null; } },
    async setPhoto(id,blob){ memPhotos.set(id,blob); try{ await tx("photos","readwrite",s => { s.put(blob,id); }); return true; }catch(e){ return false; } },
    async delPhoto(id){ memPhotos.delete(id); try{ await tx("photos","readwrite",s => { s.delete(id); }); }catch(e){} },
    async clearPhotos(){ memPhotos.clear(); try{ await tx("photos","readwrite",s => { s.clear(); }); }catch(e){} }
  };
})();

let state = {version:1,patients:[],measures:[],ui:{},onboarded:false,lastBackup:null};
let persistOK = true;
async function persist(){ persistOK = await store.setState(state); }

/* ================= Utilitaires ================= */
function uid(){ return Math.random().toString(36).slice(2,9)+Date.now().toString(36); }
function iso(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function today(){ return iso(new Date()); }
function fmtDate(s){ const [y,m,d] = s.slice(0,10).split("-"); return d+"/"+m+"/"+y.slice(2); }
function days(a,b){ return Math.round((Date.parse(b.slice(0,10)+"T12:00:00")-Date.parse(a.slice(0,10)+"T12:00:00"))/864e5); }
function deg(v){ const r = Math.round(v); return (r<0?"−":"")+Math.abs(r)+"°"; }
function sgn(v){ const r = Math.round(v); return (r>0?"+":r<0?"−":"±")+Math.abs(r)+"°"; }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function patient(id){ return state.patients.find(p => p.id===id); }
function pname(p){ return p ? p.initials+(p.extra ? " · "+p.extra : "") : ""; }
function pl(n,w){ return n+" "+w+(n>1?"s":""); }
function sideName(s){ return s==="G" ? "Gauche" : "Droite"; }
function byDateDesc(a,b){ return b.date.localeCompare(a.date) || b.created-a.created; }
function byDateAsc(a,b){ return a.date.localeCompare(b.date) || a.created-b.created; }
function measuresOf(pid){ return state.measures.filter(m => m.patientId===pid); }
function testOptions(counts){
  return GROUPS.map(([g,ids]) => '<optgroup label="'+g+'">'+ids.map(k => '<option value="'+k+'">'+esc(TESTS[k].name)+(counts && counts[k] ? " ("+counts[k]+")" : "")+'</option>').join("")+'</optgroup>').join("");
}
function setMsg(sel,html,kind){ const el = $(sel); el.innerHTML = html || ""; el.classList.toggle("err",kind==="err"); el.classList.toggle("ok",kind==="ok"); }
function isStandalone(){ return window.navigator.standalone===true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches); }

/* ================= Fichiers : partage iOS ou téléchargement ================= */
async function deliverFile(blob,name){
  const file = new File([blob],name,{type:blob.type});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file],title:name}); return "shared"; }
    catch(e){ if(e && e.name==="AbortError") return "aborted"; }
  }
  try{
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url),5000);
    return "downloaded";
  }catch(e){ return "failed"; }
}

/* ================= Patient exemple (images générées) ================= */
const DEMO = {W:900,H:1200,B:{x:470,y:330},C:{x:442,y:702},len:292};
function demoPts(angle){
  const bc = Math.atan2(DEMO.C.y-DEMO.B.y,DEMO.C.x-DEMO.B.x), a = bc-angle*Math.PI/180;
  return {A:{x:DEMO.B.x+Math.cos(a)*DEMO.len,y:DEMO.B.y+Math.sin(a)*DEMO.len},B:{...DEMO.B},C:{...DEMO.C}};
}
function makeDemo(P){
  const {W,H} = DEMO, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  const wall = x.createLinearGradient(0,0,0,H); wall.addColorStop(0,"#e7e2da"); wall.addColorStop(1,"#d9d2c6");
  x.fillStyle = wall; x.fillRect(0,0,W,H);
  x.fillStyle = "#3f8a4a"; x.fillRect(0,900,W,300);
  x.strokeStyle = "rgba(255,255,255,.6)"; x.lineWidth = 6;
  for(let i=0;i<6;i++){ x.beginPath(); x.moveTo(60+i*150,920); x.lineTo(20+i*170,1200); x.stroke(); }
  x.fillStyle = "#1c1c1c"; x.fillRect(0,770,W,60);
  x.fillStyle = "#b08a5a"; x.fillRect(80,830,22,180); x.fillRect(780,830,22,180);
  const limb = (a,b,w,col) => { x.strokeStyle = col; x.lineWidth = w; x.lineCap = "round"; x.beginPath(); x.moveTo(a[0],a[1]); x.lineTo(b[0],b[1]); x.stroke(); };
  const skin = "#b9845c", K = [P.B.x,P.B.y], A = [P.A.x,P.A.y];
  const ux = (A[0]-K[0])/DEMO.len, uy = (A[1]-K[1])/DEMO.len;
  limb([120,715],[420,712],120,"#a9bfca");
  x.fillStyle = skin; x.beginPath(); x.arc(70,700,58,0,Math.PI*2); x.fill();
  limb([440,728],[860,738],78,skin);
  limb([440,728],[600,734],96,"#a3adb3");
  limb([442,700],K,84,skin);
  limb([442,700],[455,545],104,"#a3adb3");
  limb(K,A,64,skin);
  limb(A,[A[0]+ux*88,A[1]+uy*88],58,"#f4f4f2");
  return c;
}
const demoCache = new Map();
function demoCanvas(angle){ const k = Math.round(angle); if(!demoCache.has(k)) demoCache.set(k,makeDemo(demoPts(k))); return demoCache.get(k); }
function hasExample(){ return state.patients.some(p => p.example); }
function addExample(){
  if(hasExample()) return;
  const pid = uid();
  state.patients.push({id:pid,initials:"EX",extra:"exemple",consent:true,example:true,created:Date.now()});
  const g = [128,133,139,144,150,155], d = [161,162,164], now = new Date();
  const add = (v,dt,side,note,i) => {
    const P = demoPts(v);
    state.measures.push({id:uid(),patientId:pid,date:iso(dt),test:"ake",side,angle:v,
      pts:{A:{x:P.A.x/DEMO.W,y:P.A.y/DEMO.H},B:{x:P.B.x/DEMO.W,y:P.B.y/DEMO.H},C:{x:P.C.x/DEMO.W,y:P.C.y/DEMO.H}},
      note,thumb:null,example:true,created:Date.now()+i});
  };
  g.forEach((v,i) => { const dt = new Date(now); dt.setDate(dt.getDate()-7*(g.length-1-i)); add(v,dt,"G",i===0?"Lésion ischio-jambiers gauche, J+10":"",i); });
  d.forEach((v,i) => { const dt = new Date(now); dt.setDate(dt.getDate()-14*(d.length-1-i)-1); add(v,dt,"D","Côté sain",10+i); });
}
function removeExample(){
  const ids = new Set(state.patients.filter(p => p.example).map(p => p.id));
  state.patients = state.patients.filter(p => !ids.has(p.id));
  state.measures = state.measures.filter(m => !ids.has(m.patientId));
  if(ids.has(state.ui.patientId)) state.ui.patientId = null;
  if(ids.has(state.ui.suiviPatientId)) state.ui.suiviPatientId = null;
}

/* ================= Date EXIF ================= */
function exifDate(buf){
  try{
    const v = new DataView(buf);
    if(v.getUint16(0)!==0xFFD8) return null;
    let o = 2;
    while(o < v.byteLength-4){
      const mk = v.getUint16(o);
      if((mk & 0xFF00)!==0xFF00) return null;
      if(mk===0xFFE1 && v.getUint32(o+4)===0x45786966){
        const t = o+10, le = v.getUint16(t)===0x4949;
        const g16 = p => v.getUint16(p,le), g32 = p => v.getUint32(p,le);
        const ifd = off => { const n = g16(t+off), out = []; for(let i=0;i<n;i++){ const e = t+off+2+i*12; out.push({tag:g16(e),count:g32(e+4),val:e+8}); } return out; };
        const str = e => { const p = e.count>4 ? t+g32(e.val) : e.val; let s = ""; for(let i=0;i<e.count-1;i++) s += String.fromCharCode(v.getUint8(p+i)); return s; };
        const ifd0 = ifd(g32(t+4)); let d = null;
        const ex = ifd0.find(e => e.tag===0x8769);
        if(ex){ const sub = ifd(g32(ex.val)); const e = sub.find(e => e.tag===0x9003) || sub.find(e => e.tag===0x9004); if(e) d = str(e); }
        if(!d){ const e = ifd0.find(e => e.tag===0x0132); if(e) d = str(e); }
        return d && /^\d{4}:\d\d:\d\d/.test(d) ? d.slice(0,10).replace(/:/g,"-") : null;
      }
      o += 2+v.getUint16(o+2);
    }
  }catch(e){}
  return null;
}

/* ================= Mesure courante ================= */
let cur = {src:null,iw:0,ih:0,demo:false,pts:{A:null,B:null,C:null},editingId:null,blob:null};
let s = 1, z = 1, ox = 0, oy = 0, cssW = 0, cssH = 0, dpr = 1;
let sel = "A";
const cv = $("#cv"), loupe = $("#loupe");

function allPlaced(P){ P = P || cur.pts; return KEYS.every(k => P[k]); }
function nextToPlace(){ return KEYS.find(k => !cur.pts[k]) || null; }
function angleOf(P){
  if(!allPlaced(P)) return null;
  const a = {x:P.A.x-P.B.x,y:P.A.y-P.B.y}, c = {x:P.C.x-P.B.x,y:P.C.y-P.B.y};
  const na = Math.hypot(a.x,a.y), nc = Math.hypot(c.x,c.y);
  if(!na || !nc) return 0;
  return Math.acos(clamp((a.x*c.x+a.y*c.y)/(na*nc),-1,1))*180/Math.PI;
}
function relToAbs(R,w,h){ const P = {}; KEYS.forEach(k => P[k] = R && R[k] ? {x:R[k].x*w,y:R[k].y*h} : null); return P; }
function absToRel(P,w,h){ const R = {}; KEYS.forEach(k => R[k] = {x:P[k].x/w,y:P[k].y/h}); return R; }

function setSource(src,opts){
  cur = {src,iw:src.width,ih:src.height,demo:!!opts.demo,pts:opts.pts || {A:null,B:null,C:null},editingId:opts.editingId || null,blob:opts.blob || null};
  sel = nextToPlace() || "A"; z = 1; ox = 0; oy = 0;
  $("#empty-stage").classList.add("hidden"); $("#cwrap").classList.remove("hidden");
  syncSaveButtons(); stageTag(); layout(); buildLegend();
}
function clearSource(){
  cur = {src:null,iw:0,ih:0,demo:false,pts:{A:null,B:null,C:null},editingId:null,blob:null};
  $("#empty-stage").classList.remove("hidden"); $("#cwrap").classList.add("hidden");
  syncSaveButtons(); stageTag(); buildLegend(); updateResult();
}
function syncSaveButtons(){
  $("#btn-save").textContent = cur.editingId ? "Mettre à jour la mesure" : "Enregistrer la mesure";
  $("#btn-new").classList.toggle("hidden",!cur.editingId);
}
function stageTag(){
  const m = cur.editingId && state.measures.find(x => x.id===cur.editingId);
  const t = m ? "Mesure du "+fmtDate(m.date)+(m.example ? " (exemple)" : "") : "";
  $("#stage-tag").textContent = t; $("#stage-tag").classList.toggle("hidden",!t);
}

function blobToCanvas(blob){
  return new Promise((res,rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => {
      const sc = Math.min(1,2000/Math.max(img.naturalWidth,img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth*sc); c.height = Math.round(img.naturalHeight*sc);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url); res(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("image")); };
    img.src = url;
  });
}
function canvasToBlob(c){ return new Promise(res => c.toBlob(b => res(b),"image/jpeg",.86)); }
async function loadFile(file){
  if(!file) return;
  let c;
  try{ c = await blobToCanvas(file); }
  catch(e){ setMsg("#status","Ce fichier ne se lit pas comme une image. Essayez une photo JPEG ou PNG.","err"); return; }
  const blob = await canvasToBlob(c);
  setSource(c,{blob});
  $("#note").value = "";
  let d = null;
  try{ if(file.arrayBuffer) d = exifDate(await file.arrayBuffer()); }catch(e){}
  if(d){ $("#date").value = d; setMsg("#status","Date reprise de la photo : "+fmtDate(d)+". Modifiable au-dessus."); }
  else { $("#date").value = today(); setMsg("#status",""); }
}

/* ================= Dessin ================= */
function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}
function drawScene(ctx,src,P,scale,k,active,bounds){
  ctx.drawImage(src,0,0,src.width*scale,src.height*scale);
  const S = key => P[key] ? {x:P[key].x*scale,y:P[key].y*scale} : null;
  const A = S("A"), B = S("B"), C = S("C");
  const seg = (p,q) => { ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke(); };
  ctx.lineCap = "round";
  for(const [p,col] of [[A,COLORS.A],[C,COLORS.C]]){
    if(!p || !B) continue;
    ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.lineWidth = 6*k; seg(B,p);
    ctx.strokeStyle = col; ctx.lineWidth = 3*k; seg(B,p);
  }
  if(A && B && C){
    const a1 = Math.atan2(A.y-B.y,A.x-B.x), a2 = Math.atan2(C.y-B.y,C.x-B.x);
    let d = a2-a1; while(d>Math.PI) d -= 2*Math.PI; while(d<-Math.PI) d += 2*Math.PI;
    const r = Math.max(8*k, Math.min(44*k, 0.45*Math.min(Math.hypot(A.x-B.x,A.y-B.y),Math.hypot(C.x-B.x,C.y-B.y))));
    ctx.beginPath(); ctx.moveTo(B.x,B.y); ctx.arc(B.x,B.y,r,a1,a1+d,d<0); ctx.closePath();
    ctx.fillStyle = "rgba(29,143,179,.30)"; ctx.fill();
    ctx.beginPath(); ctx.arc(B.x,B.y,r,a1,a1+d,d<0); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2*k; ctx.stroke();
    const mid = a1+d/2, lr = r+26*k, txt = Math.round(angleOf(P))+"°";
    ctx.font = "700 "+(20*k)+"px -apple-system, system-ui, sans-serif";
    const bw = ctx.measureText(txt).width+16*k, bh = 28*k;
    const bx = bounds || {x0:0,y0:0,x1:src.width*scale,y1:src.height*scale};
    const lx = clamp(B.x+Math.cos(mid)*lr, bx.x0+bw/2+4*k, bx.x1-bw/2-4*k);
    const ly = clamp(B.y+Math.sin(mid)*lr, bx.y0+bh/2+4*k, bx.y1-bh/2-4*k);
    ctx.fillStyle = "rgba(10,16,19,.86)"; roundRect(ctx,lx-bw/2,ly-bh/2,bw,bh,8*k); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(txt,lx,ly+1*k);
  }
  for(const key of ["C","A","B"]){
    const p = S(key); if(!p) continue;
    const on = key===active, rr = (on?15:12)*k;
    if(on){ ctx.beginPath(); ctx.arc(p.x,p.y,rr+7*k,0,Math.PI*2); ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.fill(); }
    ctx.beginPath(); ctx.arc(p.x,p.y,rr,0,Math.PI*2); ctx.fillStyle = COLORS[key]; ctx.fill();
    ctx.lineWidth = 3*k; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "700 "+(13*k)+"px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(key,p.x,p.y+.5*k);
  }
}
function annotated(src,P,W){
  const c = document.createElement("canvas"), sc = W/src.width;
  c.width = W; c.height = Math.round(src.height*sc);
  drawScene(c.getContext("2d"),src,P,sc,Math.max(.5,W/420),null);
  return c;
}
function layout(){
  if(!cur.src) return;
  const maxW = $("#stage").clientWidth || 360;
  const maxH = Math.max(280, Math.min(window.innerHeight*0.62, 900));
  s = Math.min(maxW/cur.iw, maxH/cur.ih);
  cssW = Math.round(cur.iw*s); cssH = Math.round(cur.ih*s);
  dpr = window.devicePixelRatio || 1;
  cv.style.width = cssW+"px"; cv.style.height = cssH+"px";
  cv.width = Math.round(cssW*dpr); cv.height = Math.round(cssH*dpr);
  clampView(); render();
}
function clampView(){ z = clamp(z,1,8); ox = clamp(ox,cssW-cssW*z,0); oy = clamp(oy,cssH-cssH*z,0); }
function render(){
  if(!cur.src){ updateResult(); return; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,cv.width,cv.height);
  ctx.setTransform(dpr*z,0,0,dpr*z,dpr*ox,dpr*oy);
  const vis = {x0:-ox/z,y0:-oy/z,x1:(cssW-ox)/z,y1:(cssH-oy)/z};
  drawScene(ctx,cur.src,cur.pts,s,1/z,gesture && gesture.type==="drag" ? gesture.key : (allPlaced() ? sel : null),vis);
  updateResult();
}
function updateResult(){
  const t = angleOf(cur.pts), T = TESTS[$("#test").value] || FALLBACK_TEST;
  $("#angle").textContent = t===null ? "–" : deg(t);
  $("#clin-wrap").classList.toggle("hidden",!T.clin);
  if(T.clin){ $("#clin-label").textContent = T.clin.label; $("#clin").textContent = t===null ? "–" : deg(T.clin.fn(t)); }
}
function updateGuide(){
  const g = $("#guide"), T = TESTS[$("#test").value] || FALLBACK_TEST;
  if(!cur.src){ g.innerHTML = "<span>Prenez ou importez une photo pour commencer.</span>"; }
  else {
    const k = nextToPlace();
    g.innerHTML = k
      ? '<span class="dot" style="background:'+COLORS[k]+'">'+k+'</span><span>Touchez <b>'+esc(T.labels[k].charAt(0).toLowerCase()+T.labels[k].slice(1))+'</b></span>'
      : "<span>Repères placés. Faites glisser un point pour l'ajuster ; pincez pour zoomer.</span>";
  }
  $$(".pt").forEach(b => b.classList.toggle("todo",!cur.pts[b.dataset.k]));
}

/* ================= Loupe ================= */
function showLoupe(k){
  const p = cur.pts[k]; if(!p) return;
  const size = 128, M = 3, spx = p.x*s*z+ox;
  loupe.style.display = "block";
  const right = spx < cssW/2;
  loupe.style.left = right ? "" : "10px"; loupe.style.right = right ? "10px" : "";
  if(loupe.width!==size*dpr){ loupe.width = size*dpr; loupe.height = size*dpr; }
  const L = loupe.getContext("2d");
  L.setTransform(dpr,0,0,dpr,0,0); L.fillStyle = "#111"; L.fillRect(0,0,size,size);
  const half = size/2/(s*z*M);
  let sx = p.x-half, sy = p.y-half, sw = 2*half, sh = 2*half, dx = 0, dy = 0, dw = size, dh = size;
  const f = size/sw;
  if(sx<0){ dx = -sx*f; dw -= dx; sw += sx; sx = 0; }
  if(sy<0){ dy = -sy*f; dh -= dy; sh += sy; sy = 0; }
  if(sx+sw>cur.iw){ const o = sx+sw-cur.iw; sw -= o; dw -= o*f; }
  if(sy+sh>cur.ih){ const o = sy+sh-cur.ih; sh -= o; dh -= o*f; }
  if(sw>0 && sh>0) L.drawImage(cur.src,sx,sy,sw,sh,dx,dy,dw,dh);
  const c = size/2, arms = [[c-26,c,c-7,c],[c+7,c,c+26,c],[c,c-26,c,c-7],[c,c+7,c,c+26]];
  for(const [w,col] of [[4,"#fff"],[2,COLORS[k]]]){ L.strokeStyle = col; L.lineWidth = w; for(const [a,b,e,d] of arms){ L.beginPath(); L.moveTo(a,b); L.lineTo(e,d); L.stroke(); } }
  L.fillStyle = COLORS[k]; L.beginPath(); L.arc(c,c,2,0,Math.PI*2); L.fill();
  L.font = "700 14px -apple-system, system-ui, sans-serif"; L.textAlign = "center"; L.textBaseline = "top"; L.fillText(k,c,8);
}
function hideLoupe(){ loupe.style.display = "none"; }

/* ================= Gestes ================= */
const ptrs = new Map(); let gesture = null;
function localXY(e){ const r = cv.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; }
function hitPoint(p,rad){
  let best = null, bd = rad;
  for(const k of ["B","A","C"]){
    const q = cur.pts[k]; if(!q) continue;
    const d = Math.hypot(q.x*s*z+ox-p.x, q.y*s*z+oy-p.y);
    if(d<bd){ bd = d; best = k; }
  }
  return best;
}
function zoomAt(m,nz){ if(!cur.src) return; const bx = (m.x-ox)/z, by = (m.y-oy)/z; z = clamp(nz,1,8); ox = m.x-bx*z; oy = m.y-by*z; clampView(); render(); }
cv.addEventListener("pointerdown",e => {
  if(!cur.src) return;
  const p = localXY(e); ptrs.set(e.pointerId,p);
  try{ cv.setPointerCapture(e.pointerId); }catch(_){}
  e.preventDefault();
  if(ptrs.size===2){
    const [a,b] = [...ptrs.values()];
    gesture = {type:"pinch",d0:Math.hypot(a.x-b.x,a.y-b.y)||1,m0:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},z0:z,ox0:ox,oy0:oy};
    hideLoupe(); cv.classList.remove("dragging"); render(); return;
  }
  if(ptrs.size>2) return;
  const hit = hitPoint(p,e.pointerType==="touch" ? 46 : 28);
  if(hit){
    gesture = {type:"drag",key:hit,id:e.pointerId,sx:p.x,sy:p.y,px:cur.pts[hit].x,py:cur.pts[hit].y};
    sel = hit; syncLegend(); cv.classList.add("dragging"); render(); showLoupe(hit); return;
  }
  gesture = {type:"tap",id:e.pointerId,sx:p.x,sy:p.y,ox0:ox,oy0:oy,moved:false};
});
cv.addEventListener("pointermove",e => {
  if(!ptrs.has(e.pointerId)) return;
  const p = localXY(e); ptrs.set(e.pointerId,p);
  const g = gesture; if(!g) return;
  if(g.type==="pinch" && ptrs.size>=2){
    const [a,b] = [...ptrs.values()];
    const d = Math.hypot(a.x-b.x,a.y-b.y), m = {x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const bx = (g.m0.x-g.ox0)/g.z0, by = (g.m0.y-g.oy0)/g.z0;
    z = clamp(g.z0*d/g.d0,1,8); ox = m.x-bx*z; oy = m.y-by*z; clampView(); render();
  } else if(g.type==="drag" && e.pointerId===g.id){
    cur.pts[g.key] = {x:clamp(g.px+(p.x-g.sx)/(s*z),0,cur.iw),y:clamp(g.py+(p.y-g.sy)/(s*z),0,cur.ih)};
    render(); showLoupe(g.key);
  } else if(g.type==="tap" && e.pointerId===g.id){
    const dx = p.x-g.sx, dy = p.y-g.sy;
    if(!g.moved && Math.hypot(dx,dy)>8) g.moved = true;
    if(g.moved && z>1){ ox = g.ox0+dx; oy = g.oy0+dy; clampView(); render(); }
  }
});
function endPtr(e){
  if(!ptrs.has(e.pointerId)) return;
  const g = gesture, p = localXY(e);
  ptrs.delete(e.pointerId);
  if(g && g.type==="tap" && e.pointerId===g.id && !g.moved && e.type==="pointerup"){
    const k = nextToPlace();
    if(k){ cur.pts[k] = {x:clamp((p.x-ox)/z/s,0,cur.iw),y:clamp((p.y-oy)/z/s,0,cur.ih)}; sel = k; syncLegend(); updateGuide(); }
  }
  if(g && g.type==="drag" && e.pointerId===g.id){ hideLoupe(); cv.classList.remove("dragging"); }
  if(ptrs.size===0 || (g && g.type==="pinch")) gesture = null;
  render();
}
cv.addEventListener("pointerup",endPtr);
cv.addEventListener("pointercancel",endPtr);
cv.addEventListener("wheel",e => { e.preventDefault(); zoomAt(localXY(e), z*Math.exp(-e.deltaY*0.0015)); },{passive:false});
$("#z-in").addEventListener("click",() => zoomAt({x:cssW/2,y:cssH/2},z*1.5));
$("#z-out").addEventListener("click",() => zoomAt({x:cssW/2,y:cssH/2},z/1.5));
$("#z-fit").addEventListener("click",() => { z = 1; ox = 0; oy = 0; render(); });
cv.addEventListener("keydown",e => {
  const key = e.key.toUpperCase();
  if(KEYS.includes(key)){ sel = key; syncLegend(); render(); return; }
  const p = cur.pts[sel]; if(!p) return;
  const st = (e.shiftKey ? 10 : 1)/(s*z);
  const mv = {ArrowLeft:[-st,0],ArrowRight:[st,0],ArrowUp:[0,-st],ArrowDown:[0,st]}[e.key];
  if(mv){ e.preventDefault(); p.x = clamp(p.x+mv[0],0,cur.iw); p.y = clamp(p.y+mv[1],0,cur.ih); render(); }
});

function buildLegend(){
  const T = TESTS[$("#test").value] || FALLBACK_TEST;
  $("#legend").innerHTML = KEYS.map(k =>
    '<button type="button" class="pt" data-k="'+k+'" aria-pressed="'+(k===sel)+'"><span class="dot" style="background:'+COLORS[k]+'">'+k+'</span><span>'+esc(T.labels[k])+'<small>'+(k==="B"?"Sommet de l'angle":"Extrémité")+'</small></span></button>'
  ).join("");
  $("#test-pos").textContent = T.pos;
  updateGuide(); updateResult();
}
function syncLegend(){ $$(".pt").forEach(b => b.setAttribute("aria-pressed",String(b.dataset.k===sel))); }
$("#legend").addEventListener("click",e => { const b = e.target.closest(".pt"); if(!b) return; sel = b.dataset.k; syncLegend(); render(); if(cur.src) cv.focus(); });

/* ================= Vue Mesure : contexte ================= */
function side(){ return $("#side-d").checked ? "D" : "G"; }
function renderMesureContext(){
  const ps = state.patients.slice().sort((a,b) => a.initials.localeCompare(b.initials));
  $("#patient").innerHTML = ps.length ? ps.map(p => '<option value="'+p.id+'">'+esc(pname(p))+'</option>').join("") : '<option value="">Aucun patient : créez-en un dans Patients</option>';
  if(state.ui.patientId && patient(state.ui.patientId)) $("#patient").value = state.ui.patientId;
  state.ui.patientId = $("#patient").value || null;
  if(!$("#test").options.length) $("#test").innerHTML = testOptions();
  if(state.ui.test && TESTS[state.ui.test]) $("#test").value = state.ui.test;
  (state.ui.side==="D" ? $("#side-d") : $("#side-g")).checked = true;
  if(!$("#date").value) $("#date").value = today();
  syncConsent(); buildLegend();
}
function syncConsent(){ const p = patient($("#patient").value); $("#consent").checked = !!(p && p.consent); $("#consent").disabled = !p; $("#consent-wrap").classList.remove("missing"); }
function saveUI(){ state.ui.patientId = $("#patient").value || null; state.ui.test = $("#test").value; state.ui.side = side(); persist(); }
$("#consent").addEventListener("change",() => { const p = patient($("#patient").value); if(p){ p.consent = $("#consent").checked; $("#consent-wrap").classList.remove("missing"); persist(); } });
$("#patient").addEventListener("change",() => { syncConsent(); saveUI(); });
$("#test").addEventListener("change",() => { buildLegend(); render(); saveUI(); });
$$('input[name="side"]').forEach(r => r.addEventListener("change",saveUI));
$("#file-cam").addEventListener("change",e => { loadFile(e.target.files[0]); e.target.value = ""; });
$("#file-lib").addEventListener("change",e => { loadFile(e.target.files[0]); e.target.value = ""; });
$("#btn-reset").addEventListener("click",() => { if(!cur.src) return; cur.pts = {A:null,B:null,C:null}; sel = "A"; syncLegend(); updateGuide(); render(); });
$("#btn-new").addEventListener("click",() => { clearSource(); $("#note").value = ""; $("#date").value = today(); setMsg("#status","Nouvelle mesure : prenez ou importez une photo."); });

$("#save-form").addEventListener("submit",async e => {
  e.preventDefault();
  if(!cur.src){ setMsg("#status","Prenez ou importez d'abord une photo du patient.","err"); return; }
  if(!allPlaced()){ setMsg("#status","Placez les trois points A, B et C avant d'enregistrer.","err"); return; }
  const pid = $("#patient").value, pat = patient(pid);
  if(!pat){ setMsg("#status",'Créez d\'abord un patient dans <a href="#patients">Patients</a>.',"err"); return; }
  if(!pat.consent){ $("#consent-wrap").classList.add("missing"); setMsg("#status","Cochez « Consentement photo recueilli » pour "+esc(pname(pat))+" avant d'enregistrer.","err"); return; }
  const date = $("#date").value; if(!date){ setMsg("#status","Indiquez la date de la séance.","err"); return; }
  const angle = Math.round(angleOf(cur.pts)*10)/10;
  const fields = {patientId:pid,date,test:$("#test").value,side:side(),angle,pts:absToRel(cur.pts,cur.iw,cur.ih),note:$("#note").value.trim()};
  const T = TESTS[fields.test] || FALLBACK_TEST, val = deg(angle)+(T.clin ? " ("+T.clin.label.toLowerCase()+" "+deg(T.clin.fn(angle))+")" : "");
  if(cur.editingId){
    const m = state.measures.find(x => x.id===cur.editingId);
    if(!m){ setMsg("#status","Cette mesure n'existe plus.","err"); return; }
    Object.assign(m,fields);
    if(!m.example) m.thumb = annotated(cur.src,cur.pts,160).toDataURL("image/jpeg",.75);
    await persist();
    setMsg("#status","Mesure du "+fmtDate(date)+" mise à jour : "+val+'. <a href="#suivi">Voir le suivi</a>',"ok");
  } else {
    const m = Object.assign({id:uid(),example:false,created:Date.now(),thumb:annotated(cur.src,cur.pts,160).toDataURL("image/jpeg",.75)},fields);
    if(cur.blob) await store.setPhoto(m.id,cur.blob);
    state.measures.push(m);
    state.ui.suiviPatientId = pid; state.ui.suiviTest = fields.test;
    await persist();
    cur.editingId = m.id; syncSaveButtons(); stageTag();
    setMsg("#status","Mesure enregistrée pour "+esc(pname(pat))+" : "+val+'. <a href="#suivi">Voir le suivi</a>',"ok");
  }
  if(!persistOK) setMsg("#status","Attention : le stockage de l'appareil a refusé l'enregistrement. Vérifiez l'espace disponible.","err");
});

async function measureSource(m){
  if(m.example) return demoCanvas(m.angle);
  const blob = await store.getPhoto(m.id); if(!blob) return null;
  return await blobToCanvas(blob);
}
async function openMeasure(id){
  const m = state.measures.find(x => x.id===id); if(!m) return;
  const src = await measureSource(m);
  if(!src){ setMsg("#s-status","La photo de cette mesure n'est plus disponible sur cet appareil.","err"); return; }
  state.ui.patientId = m.patientId; state.ui.test = m.test; state.ui.side = m.side;
  $("#date").value = m.date; $("#note").value = m.note || "";
  pendingOpen = {src,opts:{demo:!!m.example,pts:relToAbs(m.pts,src.width,src.height),editingId:m.id},msg:"Mesure du "+fmtDate(m.date)+" ouverte. Ajustez les points puis mettez à jour."};
  location.hash = "#mesure";
}
let pendingOpen = null;

/* ================= Vue Patients ================= */
function lastMeasure(pid){ return measuresOf(pid).sort(byDateDesc)[0] || null; }
function renderPatients(){
  // accueil
  const ob = $("#onboarding");
  if(!state.onboarded){
    ob.classList.remove("hidden");
    ob.innerHTML = '<div class="stack"><h2>Bienvenue dans KinéStat</h2>'+
      '<p class="tip">Mesurez un angle articulaire sur une photo en plaçant 3 points, et suivez la progression séance après séance. Tout reste sur ce téléphone.</p>'+
      '<ul class="tips"><li>Créez un patient (initiales) et cochez le consentement photo.</li><li>Dans Mesure, choisissez le test et le côté, prenez la photo, puis touchez A, B et C.</li><li>Photo de profil, perpendiculaire au mouvement, même distance à chaque séance.</li>'+
      (isStandalone() ? '' : '<li><b>Installez l\'app</b> : Partager, puis « Sur l\'écran d\'accueil ».</li>')+
      '<li>Faites une sauvegarde chiffrée régulièrement (Réglages).</li></ul>'+
      '<div class="row"><button class="btn primary" type="button" id="ob-ok">Commencer</button>'+(hasExample() ? '' : '<button class="btn" type="button" id="ob-ex">Voir un patient exemple</button>')+'</div></div>';
  } else ob.classList.add("hidden");
  // rappel de sauvegarde
  const real = state.measures.filter(m => !m.example).length;
  const rem = $("#backup-reminder");
  const stale = !state.lastBackup || days(state.lastBackup,today())>14;
  if(real>0 && stale){
    rem.classList.remove("hidden");
    rem.innerHTML = "<span>"+(state.lastBackup ? "Dernière sauvegarde le "+fmtDate(state.lastBackup)+"." : "Aucune sauvegarde pour l'instant.")+' Pensez à <a href="#reglages">faire une sauvegarde chiffrée</a>.</span>';
  } else rem.classList.add("hidden");
  // liste
  const q = $("#p-search").value.trim().toLowerCase();
  const ps = state.patients.filter(p => !q || pname(p).toLowerCase().includes(q))
    .map(p => ({p,last:lastMeasure(p.id),n:measuresOf(p.id).length}))
    .sort((a,b) => (b.last ? b.last.date : "").localeCompare(a.last ? a.last.date : "") || a.p.initials.localeCompare(b.p.initials));
  $("#patient-list").innerHTML = ps.length ? ps.map(({p,last,n}) =>
    '<div class="pcard"><div class="avatar" aria-hidden="true">'+esc(p.initials.slice(0,3))+'</div><div>'+
    '<div class="nm">'+esc(p.initials)+(p.extra ? '<small>'+esc(p.extra)+'</small>' : '')+(p.example ? '<span class="tag">exemple</span>' : '')+'</div>'+
    '<div class="sub">'+(n ? n+" mesure"+(n>1?"s":"")+" · dernière : "+esc((TESTS[last.test] || FALLBACK_TEST).short)+" "+(last.side)+" "+deg(last.angle)+" le "+fmtDate(last.date) : "Aucune mesure")+'</div>'+
    (p.consent ? '' : '<span class="flag">Consentement photo à recueillir</span>')+
    '<div class="acts"><button type="button" class="btn small primary" data-measure="'+p.id+'">Mesurer</button>'+
    '<button type="button" class="btn small" data-follow="'+p.id+'"'+(n?'':' disabled')+'>Suivi</button>'+
    '<button type="button" class="btn small danger" data-delp="'+p.id+'">Supprimer</button></div></div></div>'
  ).join("") : '<p class="empty">'+(q ? "Aucun patient ne correspond." : "Aucun patient. Ajoutez-en un avec « + Patient ».")+'</p>';
}
$("#onboarding").addEventListener("click",async e => {
  if(e.target.id==="ob-ok"){ state.onboarded = true; await persist(); renderPatients(); }
  if(e.target.id==="ob-ex"){ addExample(); state.onboarded = true; await persist(); renderPatients(); }
});
$("#p-search").addEventListener("input",renderPatients);
$("#btn-add-patient").addEventListener("click",() => { $("#patient-form").classList.toggle("hidden"); setMsg("#pf-status",""); $("#pf-initials").focus(); });
$("#pf-cancel").addEventListener("click",() => { $("#patient-form").classList.add("hidden"); });
$("#pf-initials").addEventListener("input",e => { const el = e.target, v = el.value.toUpperCase(); if(v!==el.value) el.value = v; });
$("#patient-form").addEventListener("submit",async e => {
  e.preventDefault();
  const initials = $("#pf-initials").value.trim().toUpperCase().replace(/\s+/g,"");
  const extra = $("#pf-extra").value.trim();
  if(!/^[A-ZÀ-Ÿ.\-]{1,6}$/.test(initials)){ setMsg("#pf-status","Indiquez des initiales (lettres uniquement, 6 au maximum).","err"); $("#pf-initials").focus(); return; }
  if(state.patients.some(p => p.initials===initials && (p.extra||"")===extra)){ setMsg("#pf-status","Un patient "+esc(initials)+(extra?" · "+esc(extra):"")+" existe déjà. Ajoutez un complément pour les distinguer.","err"); return; }
  const p = {id:uid(),initials,extra,consent:$("#pf-consent").checked,created:Date.now()};
  state.patients.push(p); state.ui.patientId = p.id;
  await persist();
  $("#pf-initials").value = ""; $("#pf-extra").value = ""; $("#pf-consent").checked = false;
  $("#patient-form").classList.add("hidden");
  renderPatients();
});
$("#patient-list").addEventListener("click",async e => {
  const m = e.target.closest("[data-measure]");
  if(m){ const pid = m.dataset.measure; if(cur.editingId){ const em = state.measures.find(x => x.id===cur.editingId); if(!em || em.patientId!==pid) clearSource(); } state.ui.patientId = pid; await persist(); location.hash = "#mesure"; return; }
  const f = e.target.closest("[data-follow]");
  if(f){ state.ui.suiviPatientId = f.dataset.follow; state.ui.suiviTest = null; location.hash = "#suivi"; return; }
  const d = e.target.closest("[data-delp]"); if(!d) return;
  const pid = d.dataset.delp, p = patient(pid), n = measuresOf(pid).length;
  if(!d.dataset.armed){
    d.dataset.armed = "1"; d.textContent = "Confirmer : supprimer "+(n ? "le patient et ses "+n+" mesure"+(n>1?"s":"") : "le patient");
    setTimeout(() => { if(d.isConnected){ delete d.dataset.armed; d.textContent = "Supprimer"; } },4000);
    return;
  }
  for(const mm of measuresOf(pid)) await store.delPhoto(mm.id);
  state.measures = state.measures.filter(x => x.patientId!==pid);
  state.patients = state.patients.filter(x => x.id!==pid);
  if(state.ui.patientId===pid) state.ui.patientId = null;
  if(state.ui.suiviPatientId===pid) state.ui.suiviPatientId = null;
  if(cur.editingId && !state.measures.some(x => x.id===cur.editingId)) clearSource();
  await persist(); renderPatients();
  void p;
});

/* ================= Vue Suivi ================= */
let compareSel = [], compareTouched = false;
const thumbCache = new Map();
function thumbFor(m){
  if(m.thumb) return m.thumb;
  if(!m.example) return null;
  const key = m.id+":"+m.angle;
  if(!thumbCache.has(key)){ const src = demoCanvas(m.angle); thumbCache.set(key,annotated(src,relToAbs(m.pts,src.width,src.height),160).toDataURL("image/jpeg",.75)); }
  return thumbCache.get(key);
}
function renderSuiviContext(){
  const ps = state.patients.slice().sort((a,b) => a.initials.localeCompare(b.initials));
  $("#s-patient").innerHTML = ps.length ? ps.map(p => '<option value="'+p.id+'">'+esc(pname(p))+'</option>').join("") : '<option value="">Aucun patient</option>';
  const pid = (state.ui.suiviPatientId && patient(state.ui.suiviPatientId)) ? state.ui.suiviPatientId : (state.ui.patientId && patient(state.ui.patientId) ? state.ui.patientId : $("#s-patient").value);
  $("#s-patient").value = pid || "";
  fillSuiviTests();
}
function fillSuiviTests(){
  const pid = $("#s-patient").value, ms = measuresOf(pid), counts = {};
  ms.forEach(m => counts[m.test] = (counts[m.test]||0)+1);
  $("#s-test").innerHTML = testOptions(counts);
  const last = ms.slice().sort(byDateDesc)[0];
  const t = state.ui.suiviTest && counts[state.ui.suiviTest] ? state.ui.suiviTest : (last ? last.test : (state.ui.test || "ake"));
  $("#s-test").value = t;
}
function currentList(){
  const pid = $("#s-patient").value, test = $("#s-test").value;
  return state.measures.filter(m => m.patientId===pid && m.test===test).sort(byDateAsc);
}
function renderSuivi(){
  const test = $("#s-test").value, T = TESTS[test] || FALLBACK_TEST, list = currentList();
  setMsg("#s-status","");
  const G = list.filter(m => m.side==="G"), D = list.filter(m => m.side==="D");
  const clinTxt = v => T.clin ? '<div class="s">'+esc(T.clin.label)+" : "+deg(T.clin.fn(v))+'</div>' : '';
  const tile = (arr,cls,label) => {
    if(!arr.length) return '<div class="tile '+cls+'"><div class="s">'+label+'</div><div class="v">–</div><div class="s">Pas de mesure</div></div>';
    const last = arr[arr.length-1], first = arr[0], prev = arr[arr.length-2];
    return '<div class="tile '+cls+'"><div class="s">'+label+', le '+fmtDate(last.date)+'</div><div class="v">'+deg(last.angle)+'</div>'+clinTxt(last.angle)+'<div class="s">'+
      (prev ? sgn(last.angle-prev.angle)+" vs précédente · "+sgn(last.angle-first.angle)+" depuis le "+fmtDate(first.date) : "Première mesure")+'</div></div>';
  };
  let sym = '<div class="tile"><div class="s">Indice de symétrie</div><div class="v">–</div><div class="s">Mesurez les deux côtés</div></div>';
  if(G.length && D.length){
    const g = G[G.length-1].angle, d = D[D.length-1].angle, lo = Math.min(g,d), hi = Math.max(g,d);
    const lsi = Math.round(lo/hi*100), weak = g<d ? "Gauche" : (d<g ? "Droite" : null);
    sym = '<div class="tile"><div class="s">Indice de symétrie (angle ABC)</div><div class="v">'+lsi+' %</div><div class="s">'+
      (weak ? weak+" en retrait de "+Math.round(hi-lo)+"°" : "Côtés identiques")+'</div><span class="pill '+(lsi>=90?"ok":"warn")+'">'+(lsi>=90?"≥ 90 %":"< 90 %")+'</span></div>';
  }
  $("#tiles").innerHTML = tile(G,"g","Gauche")+tile(D,"d","Droite")+sym;
  $("#chart").innerHTML = chart(list);
  compareSel = compareSel.filter(id => list.some(m => m.id===id));
  if(!compareSel.length && !compareTouched){ const ref = G.length>=D.length ? G : D; if(ref.length>=2) compareSel = [ref[0].id,ref[ref.length-1].id]; }
  renderCompare(list);
  $("#list").innerHTML = list.length ? list.slice().reverse().map(m => {
    const same = list.filter(x => x.side===m.side), i = same.indexOf(m), prev = same[i-1];
    const th = thumbFor(m), on = compareSel.includes(m.id);
    return '<div class="m'+(on?" sel":"")+'">'+(th ? '<img src="'+th+'" alt="Photo annotée du '+fmtDate(m.date)+'">' : '<div class="ph">photo</div>')+
      '<div><div class="t"><span class="side" style="background:var(--'+(m.side==="G"?"g":"d")+')"></span>'+fmtDate(m.date)+' · '+sideName(m.side)+(m.example?'<span class="tag">exemple</span>':'')+'</div>'+
      (m.note ? '<div class="n">'+esc(m.note)+'</div>' : '')+'</div>'+
      '<div class="ang">'+deg(m.angle)+(T.clin ? '<small>'+esc(T.clin.label.split(" (")[0].toLowerCase())+" "+deg(T.clin.fn(m.angle))+'</small>' : '')+
      '<small>'+(prev ? sgn(m.angle-prev.angle)+" vs préc." : "1re mesure")+'</small></div>'+
      '<div class="acts"><button type="button" class="btn small" data-open="'+m.id+'">Ouvrir</button>'+
      '<button type="button" class="btn small" data-cmp="'+m.id+'" aria-pressed="'+on+'">Comparer</button>'+
      '<button type="button" class="btn small danger" data-del="'+m.id+'">Supprimer</button></div></div>';
  }).join("") : '<p class="empty">Aucune mesure pour ce test. Enregistrez-en une depuis l\'onglet Mesure.</p>';
}
async function renderCompare(list){
  const box = $("#compare");
  const ms = compareSel.map(id => list.find(m => m.id===id)).filter(Boolean).sort(byDateAsc);
  if(ms.length<2){ box.innerHTML = '<p class="empty">'+(ms.length ? "Choisissez une deuxième mesure à comparer." : "Choisissez deux mesures dans la liste ci-dessous.")+'</p>'; return; }
  const [a,b] = ms;
  const W = Math.max(140, Math.round((box.clientWidth-10)/2)) * Math.min(2,window.devicePixelRatio||1);
  box.innerHTML = ms.map((m,i) => '<figure><div id="cmp-'+i+'"></div><figcaption><b>'+deg(m.angle)+'</b> '+fmtDate(m.date)+' · '+sideName(m.side)+'</figcaption></figure>').join("")+
    '<div class="cmp-sum">Écart : <b>'+sgn(b.angle-a.angle)+'</b> en '+days(a.date,b.date)+' jours'+(a.side!==b.side?" (côtés différents)":"")+'</div>';
  for(const [i,m] of ms.entries()){
    const src = await measureSource(m), slot = $("#cmp-"+i);
    if(!slot) return;
    if(!src){ slot.innerHTML = '<p class="empty">Photo indisponible</p>'; continue; }
    slot.appendChild(annotated(src,relToAbs(m.pts,src.width,src.height),W));
  }
}
function chart(list){
  if(!list.length) return '<p class="empty">Le graphique apparaîtra après la première mesure.</p>';
  const W = Math.max(300,Math.round($("#chart").clientWidth || 600)), H = W<480 ? 220 : 260, m = {l:44,r:44,t:18,b:30};
  const ts = list.map(x => Date.parse(x.date+"T12:00:00"));
  let t0 = Math.min(...ts), t1 = Math.max(...ts); const single = t0===t1;
  if(single){ t0 -= 864e5*7; t1 += 864e5*7; }
  const vs = list.map(x => x.angle);
  const step = Math.max(5, Math.ceil((Math.max(...vs)-Math.min(...vs)+6)/4/5)*5);
  const y0 = Math.floor((Math.min(...vs)-3)/5)*5, y1 = y0+step*4;
  const X = t => m.l+(t-t0)/(t1-t0)*(W-m.l-m.r), Y = v => m.t+(1-(v-y0)/(y1-y0))*(H-m.t-m.b);
  let out = '<svg class="chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Évolution de l\'angle par côté">';
  for(let i=0;i<=4;i++){ const v = y0+i*step, y = Y(v);
    out += '<line class="grid" x1="'+m.l+'" x2="'+(W-m.r)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(m.l-8)+'" y="'+(y+4)+'" text-anchor="end">'+v+'°</text>'; }
  const dates = [...new Set(list.map(x => x.date))].sort();
  if(single) out += '<text x="'+X(ts[0])+'" y="'+(H-8)+'" text-anchor="middle">'+fmtDate(dates[0])+'</text>';
  else out += '<text x="'+X(t0)+'" y="'+(H-8)+'" text-anchor="start">'+fmtDate(dates[0])+'</text><text x="'+X(t1)+'" y="'+(H-8)+'" text-anchor="end">'+fmtDate(dates[dates.length-1])+'</text>';
  for(const [k,cls] of [["G","g"],["D","d"]]){
    const ser = list.filter(x => x.side===k); if(!ser.length) continue;
    const P = ser.map(x => [X(Date.parse(x.date+"T12:00:00")),Y(x.angle)]);
    if(P.length>1){
      const path = P.map((p,i) => (i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" ");
      out += '<path d="'+path+' L'+P[P.length-1][0].toFixed(1)+' '+(H-m.b)+' L'+P[0][0].toFixed(1)+' '+(H-m.b)+' Z" class="f'+cls+'" opacity=".08"/>';
      out += '<path d="'+path+'" fill="none" class="l'+cls+'" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    P.forEach((p,i) => { const last = i===P.length-1;
      out += '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(last?5.5:3.5)+'" class="f'+cls+'" stroke="var(--surface)" stroke-width="2"/>'; });
    const L = P[P.length-1];
    out += '<text class="vlab" x="'+(L[0]+9)+'" y="'+(L[1]+4)+'">'+deg(ser[ser.length-1].angle)+'</text>';
  }
  return out+'</svg>';
}
$("#list").addEventListener("click",async e => {
  const o = e.target.closest("[data-open]"); if(o){ openMeasure(o.dataset.open); return; }
  const c = e.target.closest("[data-cmp]");
  if(c){ const id = c.dataset.cmp; compareSel = compareSel.includes(id) ? compareSel.filter(x => x!==id) : [...compareSel,id].slice(-2); compareTouched = true; renderSuivi(); return; }
  const b = e.target.closest("[data-del]"); if(!b) return;
  if(b.dataset.armed){
    const id = b.dataset.del;
    state.measures = state.measures.filter(m => m.id!==id); await store.delPhoto(id); await persist();
    if(cur.editingId===id) clearSource();
    renderSuivi(); return;
  }
  b.dataset.armed = "1"; b.textContent = "Confirmer";
  setTimeout(() => { if(b.isConnected){ delete b.dataset.armed; b.textContent = "Supprimer"; } },3500);
});
$("#s-patient").addEventListener("change",() => { state.ui.suiviPatientId = $("#s-patient").value; state.ui.suiviTest = null; fillSuiviTests(); compareSel = []; compareTouched = false; renderSuivi(); });
$("#s-test").addEventListener("change",() => { state.ui.suiviTest = $("#s-test").value; compareSel = []; compareTouched = false; renderSuivi(); });

/* ================= Export CSV ================= */
function csvFor(measures){
  const rows = [["date","patient","complement","test","cote","angle_ABC","valeur_clinique","libelle_valeur_clinique","note"]];
  measures.slice().sort((a,b) => { const pa = pname(patient(a.patientId)), pb = pname(patient(b.patientId)); return pa.localeCompare(pb) || byDateAsc(a,b); }).forEach(m => {
    const T = TESTS[m.test] || FALLBACK_TEST, p = patient(m.patientId) || {};
    rows.push([m.date,p.initials||"",p.extra||"",T.name,sideName(m.side),String(m.angle).replace(".",","),T.clin ? String(Math.round(T.clin.fn(m.angle)*10)/10).replace(".",",") : "",T.clin ? T.clin.label : "",m.note||""]);
  });
  return "\ufeff"+rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(";")).join("\r\n");
}
async function exportCsv(measures,name,msgSel){
  if(!measures.length){ setMsg(msgSel,"Aucune mesure à exporter.","err"); return; }
  const r = await deliverFile(new Blob([csvFor(measures)],{type:"text/csv"}),name);
  setMsg(msgSel, r==="shared" ? "Fichier CSV partagé." : r==="downloaded" ? "Fichier CSV téléchargé : "+esc(name) : r==="aborted" ? "" : "L'export n'a pas pu être créé sur cet appareil.", r==="failed" ? "err" : "ok");
}
$("#btn-csv-patient").addEventListener("click",() => {
  const pid = $("#s-patient").value, p = patient(pid);
  exportCsv(measuresOf(pid),"kinestat-"+(p ? p.initials : "patient")+"-"+today()+".csv","#s-status");
});
$("#btn-csv-all").addEventListener("click",() => exportCsv(state.measures,"kinestat-mesures-"+today()+".csv","#csv-status"));

/* ================= Sauvegarde chiffrée (AES-GCM 256, PBKDF2-SHA256) ================= */
const ITER = 310000;
function b64(u8){ let s = ""; for(let i=0;i<u8.length;i+=0x8000) s += String.fromCharCode.apply(null,u8.subarray(i,i+0x8000)); return btoa(s); }
function unb64(str){ const s = atob(str), u = new Uint8Array(s.length); for(let i=0;i<s.length;i++) u[i] = s.charCodeAt(i); return u; }
async function deriveKey(pass,salt,iter){
  const base = await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:iter,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
let preparedBackup = null, pendingRestore = null;
$("#bk-prepare").addEventListener("click",async () => {
  const p1 = $("#bk-pass").value, p2 = $("#bk-pass2").value;
  $("#bk-save").classList.add("hidden"); preparedBackup = null;
  if(!window.crypto || !crypto.subtle){ setMsg("#bk-status","Le chiffrement n'est pas disponible ici. Ouvrez l'application depuis son adresse https.","err"); return; }
  if(p1.length<8){ setMsg("#bk-status","La phrase secrète doit contenir au moins 8 caractères.","err"); return; }
  if(p1!==p2){ setMsg("#bk-status","Les deux phrases secrètes ne sont pas identiques.","err"); return; }
  setMsg("#bk-status","Chiffrement en cours…");
  $("#bk-prepare").disabled = true;
  try{
    const photos = {};
    for(const m of state.measures){ if(m.example) continue; const bl = await store.getPhoto(m.id); if(bl) photos[m.id] = b64(new Uint8Array(await bl.arrayBuffer())); }
    const plain = new TextEncoder().encode(JSON.stringify({state,photos}));
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(p1,salt,ITER);
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,plain));
    const created = new Date().toISOString();
    const payload = {format:"kinestat-backup",version:1,app:VERSION,created,kdf:"PBKDF2-SHA256",iter:ITER,cipher:"AES-GCM-256",salt:b64(salt),iv:b64(iv),data:b64(ct)};
    preparedBackup = {blob:new Blob([JSON.stringify(payload)],{type:"application/json"}),name:"kinestat-sauvegarde-"+today()+".json"};
    const mo = (preparedBackup.blob.size/1048576).toFixed(1).replace(".",",");
    setMsg("#bk-status","Sauvegarde prête ("+pl(state.patients.length,"patient")+", "+pl(state.measures.length,"mesure")+", "+mo+" Mo). Enregistrez-la dans Fichiers ou envoyez-la vers un endroit sûr.","ok");
    $("#bk-save").classList.remove("hidden");
    $("#bk-pass").value = ""; $("#bk-pass2").value = "";
  }catch(e){ setMsg("#bk-status","La sauvegarde a échoué : "+esc(e.message||e),"err"); }
  finally{ $("#bk-prepare").disabled = false; }
});
$("#bk-save").addEventListener("click",async () => {
  if(!preparedBackup) return;
  const r = await deliverFile(preparedBackup.blob,preparedBackup.name);
  if(r==="shared" || r==="downloaded"){
    state.lastBackup = today(); await persist(); renderReglages();
    setMsg("#bk-status", r==="shared" ? "Sauvegarde transmise. Vérifiez qu'elle est bien enregistrée." : "Sauvegarde téléchargée : "+esc(preparedBackup.name),"ok");
  } else if(r==="failed") setMsg("#bk-status","Le fichier n'a pas pu être enregistré.","err");
});
$("#rs-open").addEventListener("click",async () => {
  $("#rs-apply").classList.add("hidden"); pendingRestore = null;
  const f = $("#rs-file").files[0], pass = $("#rs-pass").value;
  if(!f){ setMsg("#rs-status","Choisissez le fichier de sauvegarde.","err"); return; }
  if(!pass){ setMsg("#rs-status","Saisissez la phrase secrète de cette sauvegarde.","err"); return; }
  setMsg("#rs-status","Déchiffrement en cours…");
  try{
    const payload = JSON.parse(await f.text());
    if(payload.format!=="kinestat-backup") throw new Error("format");
    const key = await deriveKey(pass,unb64(payload.salt),payload.iter);
    let plain;
    try{ plain = await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(payload.iv)},key,unb64(payload.data)); }
    catch(e){ setMsg("#rs-status","Phrase secrète incorrecte, ou fichier modifié.","err"); return; }
    const data = JSON.parse(new TextDecoder().decode(plain));
    if(!data.state || !Array.isArray(data.state.patients)) throw new Error("format");
    pendingRestore = data;
    setMsg("#rs-status","Sauvegarde du "+fmtDate(payload.created)+" : "+pl(data.state.patients.length,"patient")+", "+pl(data.state.measures.length,"mesure")+". Elle remplacera les données actuelles ("+pl(state.patients.length,"patient")+", "+pl(state.measures.length,"mesure")+").","ok");
    $("#rs-apply").classList.remove("hidden"); $("#rs-apply").textContent = "Remplacer mes données";
  }catch(e){ setMsg("#rs-status","Ce fichier n'est pas une sauvegarde KinéStat lisible.","err"); }
});
$("#rs-apply").addEventListener("click",async () => {
  const b = $("#rs-apply");
  if(!pendingRestore) return;
  if(!b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Confirmer le remplacement"; setTimeout(() => { if(b.isConnected){ delete b.dataset.armed; b.textContent = "Remplacer mes données"; } },4000); return; }
  delete b.dataset.armed;
  await store.clearPhotos();
  for(const [id,str] of Object.entries(pendingRestore.photos || {})) await store.setPhoto(id,new Blob([unb64(str)],{type:"image/jpeg"}));
  state = Object.assign({version:1,patients:[],measures:[],ui:{},onboarded:true,lastBackup:null},pendingRestore.state);
  await persist();
  pendingRestore = null; clearSource();
  b.classList.add("hidden"); $("#rs-pass").value = ""; $("#rs-file").value = "";
  setMsg("#rs-status","Données restaurées : "+pl(state.patients.length,"patient")+", "+pl(state.measures.length,"mesure")+".","ok");
  renderReglages();
});

/* ================= Vue Réglages ================= */
async function renderReglages(){
  $("#version").textContent = VERSION;
  $("#last-backup").textContent = state.lastBackup ? "Dernière sauvegarde : le "+fmtDate(state.lastBackup)+"." : "Aucune sauvegarde pour l'instant.";
  $("#btn-example").textContent = hasExample() ? "Retirer le patient exemple" : "Ajouter le patient exemple";
  let txt = state.patients.length+" patient"+(state.patients.length>1?"s":"")+", "+state.measures.length+" mesure"+(state.measures.length>1?"s":"")+". ";
  try{
    if(navigator.storage && navigator.storage.estimate){ const e = await navigator.storage.estimate(); txt += "Espace utilisé : "+((e.usage||0)/1048576).toFixed(1).replace(".",",")+" Mo. "; }
    if(navigator.storage && navigator.storage.persisted){ txt += (await navigator.storage.persisted()) ? "Stockage protégé contre l'effacement automatique. " : "Stockage non protégé : installez l'app sur l'écran d'accueil. "; }
  }catch(e){}
  txt += isStandalone() ? "Application installée." : "Ouverte dans le navigateur.";
  if(!persistOK) txt += " Attention : le dernier enregistrement a échoué.";
  $("#storage-info").textContent = txt;
}
$("#btn-example").addEventListener("click",async () => { if(hasExample()) removeExample(); else addExample(); await persist(); renderReglages(); });

/* ================= Navigation ================= */
const VIEWS = {patients:"Patients",mesure:"Mesure",suivi:"Suivi",reglages:"Réglages"};
let currentView = null;
function route(){
  let v = location.hash.slice(1); if(!VIEWS[v]) v = "patients";
  const changed = v!==currentView; currentView = v;
  for(const k of Object.keys(VIEWS)){
    $("#view-"+k).classList.toggle("hidden",k!==v);
    const a = $("#tab-"+k); if(k===v) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current");
  }
  $("#title").textContent = VIEWS[v];
  if(v==="patients") renderPatients();
  if(v==="mesure"){
    renderMesureContext();
    if(pendingOpen){ const po = pendingOpen; pendingOpen = null; setSource(po.src,po.opts); setMsg("#status",po.msg); }
    else layout();
  }
  if(v==="suivi"){ renderSuiviContext(); compareSel = []; compareTouched = false; renderSuivi(); }
  if(v==="reglages") renderReglages();
  if(changed) window.scrollTo(0,0);
}
window.addEventListener("hashchange",route);
let raf = 0;
window.addEventListener("resize",() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if(currentView==="mesure") layout(); }); });

/* ================= Installation iOS ================= */
function initInstallBanner(){
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
  let dismissed = false; try{ dismissed = sessionStorage.getItem("ks-install")==="1"; }catch(e){}
  if(ios && !isStandalone() && !dismissed) $("#install-banner").classList.remove("hidden");
  $("#install-close").addEventListener("click",() => { $("#install-banner").classList.add("hidden"); try{ sessionStorage.setItem("ks-install","1"); }catch(e){} });
}

/* ================= Démarrage ================= */
(async function init(){
  try{ await loadCatalogue(); }
  catch(e){
    TESTS = {libre:FALLBACK_TEST}; GROUPS = [["Autre",["libre"]]];
    document.querySelector(".banners").insertAdjacentHTML("beforeend",'<div class="note warn"><span>Le catalogue des tests (tests.json) n\'a pas pu être chargé. Seule la mesure libre est disponible. Rouvrez l\'application avec une connexion.</span></div>');
  }
  $("#test").innerHTML = testOptions();
  $("#date").value = today();
  try{
    const saved = await store.getState();
    if(saved && Array.isArray(saved.patients)) state = Object.assign({version:1,patients:[],measures:[],ui:{},onboarded:false,lastBackup:null},saved);
  }catch(e){}
  state.ui = state.ui || {};
  try{ if(navigator.storage && navigator.storage.persist) await navigator.storage.persist(); }catch(e){}
  initInstallBanner();
  clearSource();
  route();
  if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost" || location.hostname==="127.0.0.1")){
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
})();
