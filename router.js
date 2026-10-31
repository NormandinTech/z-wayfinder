// Road router: shortest road route with off-road legs and turn-by-turn directions.
// RoadRouter.create(roads, placeName) -> {route(A,B), directions(legs,dest), snap(x,z)}
// roads: {nodes:[[x,z]], edges:[{a,b,pts,len,major?,kind?}]}; placeName(x,z,arrive) -> "near Town"
(function (root) {
'use strict';
function create(roads, placeName) {
const N = roads.nodes.length; const adj = Array.from({length: N}, () => []);
roads.edges.forEach((e,i)=>{const w=e.len*(e.major?0.9:e.kind==='path'?1.6:1)*(e.gap?1.15:1);adj[e.a].push({to:e.b,w,ei:i,fwd:true});adj[e.b].push({to:e.a,w,ei:i,fwd:false});});
const segLen=(a,b)=>Math.hypot(b[0]-a[0],b[1]-a[1]);
// snap a point to the nearest spot on any road
function snap(x,z){
  let best=null;
  roads.edges.forEach((e,ei)=>{let acc=0;for(let i=0;i<e.pts.length-1;i++){const a=e.pts[i],b=e.pts[i+1];const dx=b[0]-a[0],dz=b[1]-a[1];const L2=dx*dx+dz*dz;let t=L2?((x-a[0])*dx+(z-a[1])*dz)/L2:0;t=Math.max(0,Math.min(1,t));const px=a[0]+t*dx,pz=a[1]+t*dz;const d=Math.hypot(x-px,z-pz);const sl=Math.sqrt(L2);if(!best||d<best.d)best={d,ei,i,t,p:[px,pz],along:acc+t*sl};acc+=sl;}});
  const e=roads.edges[best.ei]; best.total=e.pts.reduce((s,p,i)=>i?s+segLen(e.pts[i-1],p):0,0); return best;
}
function slice(e,fromAlong,toAlong){ // polyline between two distances along edge (either direction)
  const rev=fromAlong>toAlong; let a=Math.min(fromAlong,toAlong), b=Math.max(fromAlong,toAlong);
  const out=[]; let acc=0;
  for(let i=0;i<e.pts.length-1;i++){const p=e.pts[i],q=e.pts[i+1];const sl=segLen(p,q);const s0=acc,s1=acc+sl;
    const lerp=s=>[p[0]+(q[0]-p[0])*((s-s0)/(sl||1)),p[1]+(q[1]-p[1])*((s-s0)/(sl||1))];
    if(s1>=a&&s0<=b){ if(!out.length) out.push(lerp(Math.max(a,s0))); if(s1<=b) out.push(q); else {out.push(lerp(b));break;} }
    acc=s1;}
  return rev?out.reverse():out;
}
const OFF=3.5; // off-road cost multiplier (slower, rougher)
function route(A,B){ // A,B: [x,z]
  if(!roads.edges.length) return [{type:'off',pts:[A,B]}];
  const sa=snap(A[0],A[1]), sb=snap(B[0],B[1]);
  const direct=segLen(A,B);
  // virtual nodes: N = start, N+1 = end
  const extra={}; const add=(u,v)=>{(extra[u]=extra[u]||[]).push(v);};
  const ea=roads.edges[sa.ei], eb=roads.edges[sb.ei];
  add(N,{to:ea.a,w:sa.d*OFF+sa.along,kind:'s',e:ea,from:sa.along,toA:0});
  add(N,{to:ea.b,w:sa.d*OFF+(sa.total-sa.along),kind:'s',e:ea,from:sa.along,toA:sa.total});
  add(eb.a,{to:N+1,w:sb.d*OFF+sb.along,kind:'e',e:eb,from:0,toA:sb.along});
  add(eb.b,{to:N+1,w:sb.d*OFF+(sb.total-sb.along),kind:'e',e:eb,from:sb.total,toA:sb.along});
  if(sa.ei===sb.ei) add(N,{to:N+1,w:sa.d*OFF+Math.abs(sa.along-sb.along)+sb.d*OFF,kind:'same',e:ea,from:sa.along,toA:sb.along});
  add(N,{to:N+1,w:direct*OFF,kind:'direct'});
  const dist=new Float64Array(N+2).fill(Infinity), prev=new Array(N+2); dist[N]=0;
  const pq=[[0,N]];
  while(pq.length){ // small graph: simple binary heap
    let bi=0;for(let i=1;i<pq.length;i++) if(pq[i][0]<pq[bi][0]) bi=i;
    const [d,u]=pq.splice(bi,1)[0]; if(d>dist[u]) continue; if(u===N+1) break;
    const list=(u<N?adj[u]:[]).concat(extra[u]||[]);
    for(const v of list){const nd=d+v.w;if(nd<dist[v.to]){dist[v.to]=nd;prev[v.to]={u,v};pq.push([nd,v.to]);}}
  }
  // rebuild
  const steps=[]; let cur=N+1; while(cur!==N){const p=prev[cur]; if(!p) return null; steps.push(p); cur=p.u;} steps.reverse();
  const legs=[]; // {type:'road'|'off', pts:[[x,z]...], node?:index}
  for(const {u,v} of steps){
    if(v.kind==='direct'){legs.push({type:'off',pts:[A,B]});continue;}
    if(v.kind==='s'){legs.push({type:'off',pts:[A,sa.p]});legs.push({type:'road',pts:slice(v.e,v.from,v.toA),node:v.to});continue;}
    if(v.kind==='same'){legs.push({type:'off',pts:[A,sa.p]});legs.push({type:'road',pts:slice(v.e,v.from,v.toA)});legs.push({type:'off',pts:[sb.p,B]});continue;}
    if(v.kind==='e'){legs.push({type:'road',pts:slice(v.e,v.from,v.toA),node:u});legs.push({type:'off',pts:[sb.p,B]});continue;}
    const e=roads.edges[v.ei]; legs.push({type:'road',pts:v.fwd?e.pts:[...e.pts].reverse(),node:v.to,fromNode:u});
  }
  return legs.filter(l=>l.pts.length>1&&!(l.type==='off'&&segLen(l.pts[0],l.pts[l.pts.length-1])<15));
}
const bearing=(a,b)=>(Math.atan2(b[0]-a[0],b[1]-a[1])*180/Math.PI+360)%360;
const compass=b=>['north','north-east','east','south-east','south','south-west','west','north-west'][Math.round(b/45)%8];
const degree=i=>adj[i]?adj[i].length:0;
function headingAt(pts,fromEnd,distWant=60){ // direction over the last/first ~60m of a polyline
  if(fromEnd){let acc=0;for(let i=pts.length-1;i>0;i--){acc+=segLen(pts[i-1],pts[i]);if(acc>=distWant||i===1)return bearing(pts[i-1],pts[pts.length-1]);}}
  else{let acc=0;for(let i=1;i<pts.length;i++){acc+=segLen(pts[i-1],pts[i]);if(acc>=distWant||i===pts.length-1)return bearing(pts[0],pts[i]);}}
  return 0;
}
function turnWord(a){
  const A=Math.abs(a);
  if(A<25) return null;
  if(A<55) return {t:a>0?'Bear right':'Bear left',ic:a>0?'↗':'↖'};
  if(A<135) return {t:a>0?'Turn right':'Turn left',ic:a>0?'→':'←'};
  return {t:a>0?'Sharp right':'Sharp left',ic:a>0?'↪':'↩'};
}
function directions(legs,dest){
  const out=[]; let run=0;
  const lenOf=l=>l.pts.reduce((s,p,i)=>i?s+segLen(l.pts[i-1],p):0,0);
  legs.forEach((l,i)=>{
    const L_=lenOf(l);
    if(l.type==='off'){
      if(run>0){out.push({ic:'↑',t:'Follow the road',d:run});run=0;}
      const b=bearing(l.pts[0],l.pts[l.pts.length-1]);
      const toRoad=legs[i+1]&&legs[i+1].type==='road';
      out.push({ic:'⇢',t:(i===0?'Head ':'Go ')+compass(b)+' off-road'+(toRoad?' to the road':' to '+placeName(dest[0],dest[1],true).replace(/^(near|at) /,'')),d:L_});
      return;
    }
    run+=L_;
    const next=legs[i+1];
    if(!(next&&next.type==='road'&&l.node!=null&&degree(l.node)>=3)) return;
    const hin=headingAt(l.pts,true), hout=headingAt(next.pts,false);
    const n=roads.nodes[l.node];
    const last=out[out.length-1];
    // junction clusters: a second turn within 80 m is merged into the previous one
    if(last&&last.turn&&run<80){
      const a2=((hout-last.hin+540)%360)-180; const w=turnWord(a2);
      if(w){Object.assign(last,{ic:w.ic,t:w.t+' '+last.where});} else out.pop();
      return;
    }
    const a=((hout-hin+540)%360)-180; const w=turnWord(a);
    if(!w) return;
    const where=placeName(n[0],n[1]);
    out.push({ic:w.ic,t:w.t+' '+where,where,hin,d:run,turn:true}); run=0;
  });
  if(run>0) out.push({ic:'↑',t:'Follow the road',d:run});
  out.push({ic:'⚑',t:'Arrive '+placeName(dest[0],dest[1],true),d:0});
  return out;
}


return { route, directions, snap, segLen };
}
const api = { create };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RoadRouter = api;
})(typeof self !== 'undefined' ? self : this);
