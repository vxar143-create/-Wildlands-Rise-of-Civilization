(() => {
  const socket = io();
  const canvas = document.getElementById("world");
  const ctx = canvas.getContext("2d");
  const $ = (id) => document.getElementById(id);
  let playerKey = localStorage.getItem("wildlands-player-key");
  if (!playerKey) { playerKey = (crypto.randomUUID ? crypto.randomUUID() : "p" + Date.now() + Math.random().toString(36).slice(2)); localStorage.setItem("wildlands-player-key", playerKey); }
  const state = {
    me: null, players: new Map(), tiles: new Map(), resources: new Map(),
    keys: new Set(), direction: { dx: 0, dy: 0 }, selectedColor: "#73d68b",
    lastMove: 0, lastWorldFetch: 0, dayTime: 0.28, camera: { x: 0, y: 0 }, tileSize: 42
  };
  const biomeColors = {
    water: "#326f83", beach: "#c5b77e", meadow: "#75a95f",
    forest: "#477d4c", taiga: "#426b55", desert: "#c6a15e", mountain: "#777e76"
  };
  const biomeNames = {water:"Море",beach:"Узбережжя",meadow:"Луки",forest:"Ліс",taiga:"Тайга",desert:"Пустеля",mountain:"Гори"};
  const tileKey = (x,y) => `${x},${y}`;
  let toastTimer;
  function toast(message) {
    const el = $("toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr); canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener("resize", resize); resize();

  document.querySelectorAll(".color-choice").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".color-choice").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected"); state.selectedColor = btn.dataset.color;
  }));
  $("playBtn").addEventListener("click", () => {
    const nickname = $("nickname").value.trim().slice(0,18) || "Мандрівник";
    socket.emit("join", { nickname, color: state.selectedColor, playerKey }, (result) => {
      if (!result?.ok) return toast("Не вдалося увійти. Спробуй ще раз.");
      state.me = result.self; state.players.clear();
      result.players.forEach(p => state.players.set(p.id,p));
      $("playerName").textContent = state.me.nickname;
      $("joinScreen").classList.add("hidden"); $("game").classList.remove("hidden");
      refreshWorld(true); updateHud(); requestAnimationFrame(loop);
    });
  });
  $("nickname").addEventListener("keydown", e => { if (e.key === "Enter") $("playBtn").click(); });

  socket.on("connect_error", () => toast("Немає зв'язку із сервером."));
  socket.on("player:joined", p => { state.players.set(p.id,p); updateHud(); });
  socket.on("player:left", p => { state.players.delete(p.id); updateHud(); });
  socket.on("player:moved", p => {
    if (state.me?.id === p.id) { state.me.x=p.x; state.me.y=p.y; }
    else { const old=state.players.get(p.id); if(old) Object.assign(old,p); }
    updateHud();
  });
  socket.on("inventory", p => { if(state.me && p.id===state.me.id){state.me=p;updateHud();} });
  socket.on("resource:changed", r => {
    const node = state.resources.get(r.id); if(node){ if(r.amount<=0)state.resources.delete(r.id); else node.amount=r.amount; }
  });
  socket.on("chat", item => addChat(item));

  function addChat(item) {
    const line = document.createElement("p"); line.className="chat-line";
    const name = document.createElement("b"); name.textContent=item.nickname+": ";
    const msg = document.createElement("span"); msg.textContent=item.message;
    line.append(name,msg); $("chatMessages").append(line);
    $("chatMessages").scrollTop=$("chatMessages").scrollHeight;
    while($("chatMessages").children.length>35)$("chatMessages").firstChild.remove();
  }
  $("chatForm").addEventListener("submit", e => {
    e.preventDefault(); const input=$("chatInput"); const msg=input.value.trim();
    if(msg){socket.emit("chat",msg);input.value="";}
  });
  $("helpBtn").onclick=()=> $("helpModal").classList.remove("hidden");
  $("closeHelp").onclick=$("closeHelp2").onclick=()=> $("helpModal").classList.add("hidden");

  function updateHud() {
    if(!state.me)return;
    $("woodCount").textContent=state.me.wood||0; $("stoneCount").textContent=state.me.stone||0;
    $("berryCount").textContent=state.me.berries||0;
    $("coords").textContent=`${Math.round(state.me.x)}, ${Math.round(state.me.y)}`;
    $("onlineCount").textContent=`${state.players.size+1} онлайн`;
    const list=[state.me,...state.players.values()].slice(0,8);
    $("playerList").textContent=list.map(p=>p.nickname).join(" • ");
  }
  async function refreshWorld(force=false) {
    if(!state.me)return;
    const t=Date.now(); if(!force && t-state.lastWorldFetch<1800)return; state.lastWorldFetch=t;
    try{
      const url=`/api/world?x=${Math.round(state.me.x)}&y=${Math.round(state.me.y)}&radius=20`;
      const data=await fetch(url).then(r=>r.json());
      data.tiles.forEach(tile=>state.tiles.set(tileKey(tile.x,tile.y),tile));
      state.resources.clear(); data.resources.forEach(r=>state.resources.set(r.id,r));
    }catch(e){toast("Не вдалося завантажити ділянку світу.");}
  }
  function movementVector() {
    let dx=0,dy=0;
    if(state.keys.has("w")||state.keys.has("arrowup"))dy-=1;
    if(state.keys.has("s")||state.keys.has("arrowdown"))dy+=1;
    if(state.keys.has("a")||state.keys.has("arrowleft"))dx-=1;
    if(state.keys.has("d")||state.keys.has("arrowright"))dx+=1;
    return {dx,dy};
  }
  window.addEventListener("keydown",e=>{
    const k=e.key.toLowerCase();
    if(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright"," "].includes(k))e.preventDefault();
    state.keys.add(k);
    if(k==="e"||k===" ")gatherNearest();
  });
  window.addEventListener("keyup",e=>state.keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur",()=>state.keys.clear());
  document.querySelectorAll("[data-dir]").forEach(btn=>{
    const map={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
    const start=e=>{e.preventDefault();const [dx,dy]=map[btn.dataset.dir];state.direction={dx,dy};};
    const stop=e=>{e.preventDefault();state.direction={dx:0,dy:0};};
    btn.addEventListener("pointerdown",start);btn.addEventListener("pointerup",stop);
    btn.addEventListener("pointerleave",stop);btn.addEventListener("pointercancel",stop);
  });
  $("gatherBtn").addEventListener("click",gatherNearest);

  function gatherNearest() {
    if(!state.me)return;
    let best=null,bestD=2.25;
    for(const r of state.resources.values()){
      const d=Math.hypot(r.x-state.me.x,r.y-state.me.y);
      if(d<bestD){best=r;bestD=d;}
    }
    if(!best){toast("Поруч немає ресурсів.");return;}
    socket.emit("gather",{x:best.x,y:best.y},result=>{
      if(!result?.ok){toast(result?.error||"Не вдалося зібрати.");return;}
      state.me=result.inventory; updateHud();
      const labels={tree:"деревину",stone:"камінь",berries:"ягоди",shell:"мушлю"};
      toast(`Зібрано: ${labels[result.kind]||"ресурс"}!`);
      if(best.kind==="shell")toast("Знайдена мушля! Її поки не можна зберігати в інвентарі.");
    });
  }

  function worldToScreen(x,y) {
    return {x:innerWidth/2+(x-state.me.x)*state.tileSize,y:innerHeight/2+(y-state.me.y)*state.tileSize};
  }
  function drawTile(tile) {
    const p=worldToScreen(tile.x,tile.y),s=state.tileSize+1;
    ctx.fillStyle=biomeColors[tile.biome]||"#638a55";ctx.fillRect(p.x-s/2,p.y-s/2,s,s);
    const h=((tile.x*13+tile.y*7)%11+11)%11;
    if(tile.biome==="water"){
      ctx.strokeStyle="rgba(195,235,235,.22)";ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(p.x-11,p.y+h-5);ctx.quadraticCurveTo(p.x,p.y+h-9,p.x+12,p.y+h-5);ctx.stroke();
    } else if(tile.biome==="meadow"||tile.biome==="forest"||tile.biome==="taiga"){
      ctx.strokeStyle="rgba(222,242,169,.2)";ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(p.x-7,p.y+5);ctx.lineTo(p.x-9,p.y-2);ctx.moveTo(p.x,p.y+7);ctx.lineTo(p.x+2,p.y-1);ctx.stroke();
    }
    ctx.strokeStyle="rgba(15,35,20,.08)";ctx.strokeRect(p.x-s/2,p.y-s/2,s,s);
  }
  function drawResource(r) {
    const p=worldToScreen(r.x,r.y);ctx.save();ctx.translate(p.x,p.y);
    if(r.kind==="tree"){
      ctx.fillStyle="#63472e";ctx.fillRect(-3,0,6,13);
      ctx.fillStyle="#1e5734";ctx.beginPath();ctx.arc(0,-4,13,0,Math.PI*2);ctx.fill();
      ctx.fillStyle="#347b43";ctx.beginPath();ctx.arc(-5,-8,7,0,Math.PI*2);ctx.fill();
    } else if(r.kind==="stone"){
      ctx.fillStyle="#929b98";ctx.beginPath();ctx.moveTo(-10,7);ctx.lineTo(-7,-5);ctx.lineTo(1,-11);ctx.lineTo(10,-4);ctx.lineTo(8,8);ctx.closePath();ctx.fill();
      ctx.strokeStyle="#c5ceca";ctx.stroke();
    } else if(r.kind==="berries"){
      ctx.fillStyle="#397849";ctx.beginPath();ctx.arc(0,0,8,0,Math.PI*2);ctx.fill();
      ctx.fillStyle="#8c5cc1";[[-4,-2],[3,-4],[2,3]].forEach(([x,y])=>{ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();});
    } else if(r.kind==="shell"){
      ctx.fillStyle="#ead8b4";ctx.beginPath();ctx.arc(0,0,7,Math.PI,Math.PI*2);ctx.lineTo(7,4);ctx.lineTo(-7,4);ctx.closePath();ctx.fill();
    }
    ctx.restore();
  }
  function drawPlayer(p,isMe=false) {
    const s=worldToScreen(p.x,p.y);ctx.save();ctx.translate(s.x,s.y);
    ctx.fillStyle="#0005";ctx.beginPath();ctx.ellipse(0,10,10,4,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.color||"#73d68b";ctx.beginPath();ctx.arc(0,0,9,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=isMe?"#fff":"#142318";ctx.lineWidth=isMe?2:1.5;ctx.stroke();
    ctx.fillStyle="#183024";ctx.beginPath();ctx.arc(-3,-2,1.2,0,Math.PI*2);ctx.arc(3,-2,1.2,0,Math.PI*2);ctx.fill();
    ctx.font="10px Manrope";ctx.textAlign="center";ctx.fillStyle="#fff";ctx.shadowColor="#000";ctx.shadowBlur=4;ctx.fillText(p.nickname,0,-16);
    ctx.restore();
  }
  function loop(t) {
    if(!state.me)return;
    ctx.clearRect(0,0,innerWidth,innerHeight);
    const dir=state.direction.dx||state.direction.dy?state.direction:movementVector();
    if((dir.dx||dir.dy)&&t-state.lastMove>75){socket.emit("move",dir);state.lastMove=t;}
    const cx=Math.round(state.me.x),cy=Math.round(state.me.y);
    const biome=state.tiles.get(tileKey(cx,cy))?.biome||"forest";
    $("biomeName").textContent=biomeNames[biome]||"Невідомо";
    const radius=Math.ceil(Math.max(innerWidth,innerHeight)/state.tileSize/2)+2;
    for(let y=cy-radius;y<=cy+radius;y++)for(let x=cx-radius;x<=cx+radius;x++){
      const tile=state.tiles.get(tileKey(x,y));if(tile)drawTile(tile);
    }
    for(const r of state.resources.values())drawResource(r);
    state.players.forEach(p=>drawPlayer(p,false));drawPlayer(state.me,true);
    state.dayTime=(state.dayTime+0.000025)%1;
    const night=Math.max(0,(Math.cos(state.dayTime*Math.PI*2)+0.15)/1.15);
    ctx.fillStyle=`rgba(8,16,34,${night*.38})`;ctx.fillRect(0,0,innerWidth,innerHeight);
    $("timeLabel").textContent=night>.55?"Ніч":night>.2?"Вечір":"День";
    refreshWorld();requestAnimationFrame(loop);
  }
})();
