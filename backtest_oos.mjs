// OUT-OF-SAMPLE check: refit β on data.json EXCLUDING the 2026 test window, then
// re-run gate-2 P&L on the cached 2026 events. If OOS β(3) ≈ in-sample 0.68 and the
// P&L grid barely moves, the edge isn't an artifact of fitting β on the test data.
import { readFileSync } from "node:fs";

const TZMAP = { DEN:"America/Denver", NYC:"America/New_York", LAX:"America/Los_Angeles",
  MDW:"America/Chicago", PHX:"America/Phoenix", SAT:"America/Chicago", DFW:"America/Chicago",
  AUS:"America/Chicago", SEA:"America/Los_Angeles", DCA:"America/New_York", BOS:"America/New_York" };
const data = JSON.parse(readFileSync("data.json","utf-8"));
const fmtCache={};
function parts(ts,tz){ (fmtCache[tz] ??= new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false}));
  const p=Object.fromEntries(fmtCache[tz].formatToParts(new Date(ts+"Z")).map(x=>[x.type,x.value])); return {day:`${p.year}-${p.month}-${p.day}`,hour:parseInt(p.hour,10)%24}; }

// Refit β by hour using ONLY pre-2026-03-20 city-days (the test window is 2026-03-20+).
const CUTOFF = "2026-03-20";
const HRS=[1,2,3,4,5,6,7,8,9]; // hrsToPeak = 15 - clockHour ; clock = 15 - hp
const acc={}; for(const hp of HRS) acc[hp]={sxy:0,sxx:0,sx:0,sy:0,n:0};
for(const [code,c] of Object.entries(data.cities)){ const tz=TZMAP[code]; if(!tz) continue;
  const day={};
  const fold=(t,p,w)=>{ for(let i=0;i<t.length;i++){ const v=p[i]; if(v==null)continue; const {day:dk,hour}=parts(t[i],tz);
    (day[dk] ??= {at:{}}); const D=day[dk];
    if(w==="o"){ if(D.hiO==null||v>D.hiO)D.hiO=v; (D.at.o??={})[hour]=v; } else { if(D.hiF==null||v>D.hiF)D.hiF=v; (D.at.f??={})[hour]=v; } } };
  fold(c.obs.times,c.obs.temps,"o"); fold(c.fc.times,c.fc.temps,"f");
  for(const dk of Object.keys(day)){ if(dk>=CUTOFF) continue; const D=day[dk]; if(D.hiO==null||D.hiF==null)continue; const y=D.hiO-D.hiF;
    for(const hp of HRS){ const clk=15-hp; const o=D.at.o?.[clk], f=D.at.f?.[clk]; if(o==null||f==null)continue; const x=o-f;
      const a=acc[hp]; a.sxy+=x*y;a.sxx+=x*x;a.sx+=x;a.sy+=y;a.n++; } }
}
const oosBeta={}; for(const hp of HRS){ const a=acc[hp],n=a.n,mx=a.sx/n,my=a.sy/n; oosBeta[hp]=(a.sxy/n-mx*my)/(a.sxx/n-mx*mx); }
console.log(`OOS β refit on pre-${CUTOFF} city-days (n≈${acc[3].n} per hour):`);
console.log("hrsToPeak:", HRS.map(h=>`${h}:${oosBeta[h].toFixed(2)}`).join("  "));
console.log(`In-sample β(3)=0.68  →  OOS β(3)=${oosBeta[3].toFixed(3)}\n`);

// gate-2 sim with OOS β
function normCdf(x){ const t=1/(1+0.2316419*Math.abs(x)); const d=0.3989423*Math.exp(-x*x/2);
  const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0?1-p:p; }
const fee=p=>0.07*(1-p);
const raw=JSON.parse(readFileSync("_edge_raw.json","utf-8"));
const betaOOS = oosBeta[3]; // noon decision → hrsToPeak 3
function pBuckets(mu,sig,bk){ const r=bk.map(b=>{const lo=b.lo==null?-Infinity:b.lo-0.5,hi=b.hi==null?Infinity:b.hi+0.5;
  const pH=hi===Infinity?1:normCdf((hi-mu)/sig),pL=lo===-Infinity?0:normCdf((lo-mu)/sig);return Math.max(0,pH-pL);});
  const s=r.reduce((a,b)=>a+b,0); return s>0?r.map(x=>x/s):r.map(()=>0); }
function sim(sig,thr){ let pnl=0,stake=0,nb=0,w=0;
  for(const e of raw){ const mu=e.fcHigh+betaOOS*(e.obsDec-e.fcDec); const ps=pBuckets(mu,sig,e.buckets);
    for(let i=0;i<e.buckets.length;i++){ const b=e.buckets[i],p=ps[i]; const noAsk=b.yesBid>0?1-b.yesBid:null;
      const evY=b.yesAsk>0&&b.yesAsk<1?p-b.yesAsk-fee(b.yesAsk):-1; const evN=noAsk!=null&&noAsk<1?(1-p)-noAsk-fee(noAsk):-1;
      let side=null,price=null; if(evY>=evN&&evY>thr){side="y";price=b.yesAsk;} else if(evN>thr){side="n";price=noAsk;}
      if(!side||price<0.05||price>0.95)continue; const won=side==="y"?b.result==="yes":b.result==="no";
      pnl+=(won?1:0)-price-fee(price); stake+=price; nb++; if(won)w++; } }
  return {nb,winPct:nb?100*w/nb:0,pnl,roi:stake>0?100*pnl/stake:0}; }
console.log(`===== GATE 2 with OOS β(3)=${betaOOS.toFixed(3)} (n_events=${raw.length}) =====`);
console.log("σ-model | EV thr | #bets | win% | total P&L | ROI/stake");
for(const sg of [2.0,2.5,3.0]) for(const thr of [0.05,0.10,0.15]){ const r=sim(sg,thr);
  console.log(`${sg.toFixed(1).padEnd(8)}| ${thr.toFixed(2)}   | ${String(r.nb).padStart(4)}  | ${r.winPct.toFixed(0).padStart(3)}  | $${r.pnl.toFixed(2).padStart(8)} | ${r.roi.toFixed(1).padStart(6)}%`); }
