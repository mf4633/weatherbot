// GATE 2 — fee-aware bucket-level P&L backtest. The "would we have made money" test.
// For each historical event, at local-noon decision time:
//   model μ = forecast_high + β(hrsToPeak)·(obs_noon − fc_noon)   [corrected model]
//   p_model(bucket) = normalized truncated-normal mass on [lo-0.5, hi+0.5] at (μ, σ)
//   yes_ask / no_ask = historical Kalshi prices at noon (candlesticks)
//   result = Kalshi ground-truth settlement (yes/no)
// Bet whichever side has model-EV > threshold at the quoted ask (price in [0.05,0.95]),
// flat 1 contract, P&L = (won?1:0) − price − fee, fee = 0.07·(1−price). Report ROI.
//
// Caches raw per-bucket records to _edge_raw2.json so σ/threshold sweeps re-run offline.
// Usage: node backtest_bucket_pnl.mjs [maxEventsPerCity]
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const K = "https://api.elections.kalshi.com/trade-api/v2";
const MAXEV = parseInt(process.argv[2] || "30", 10);
const DEC_HR = 12;
const TZMAP = { DEN:"America/Denver", NYC:"America/New_York", LAX:"America/Los_Angeles",
  MDW:"America/Chicago", PHX:"America/Phoenix", SAT:"America/Chicago", DFW:"America/Chicago",
  AUS:"America/Chicago", SEA:"America/Los_Angeles", DCA:"America/New_York", BOS:"America/New_York",
  HOU:"America/Chicago", PHL:"America/New_York" };
const SERIESMAP = { DEN:"KXHIGHDEN", NYC:"KXHIGHNY", LAX:"KXHIGHLAX", MDW:"KXHIGHCHI",
  PHX:"KXHIGHTPHX", SAT:"KXHIGHTSATX", DFW:"KXHIGHTDAL", AUS:"KXHIGHAUS",
  SEA:"KXHIGHTSEA", DCA:"KXHIGHTDC", BOS:"KXHIGHTBOS",
  HOU:"KXHIGHTHOU", PHL:"KXHIGHPHIL" };
const CITIES = Object.keys(SERIESMAP);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jget(u){ for(let i=0;i<3;i++){ try{ const r=await fetch(u); if(r.ok) return await r.json(); }catch(e){} await sleep(250); } return null; }
function normCdf(x){ const t=1/(1+0.2316419*Math.abs(x)); const d=0.3989423*Math.exp(-x*x/2);
  const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0?1-p:p; }
const TAB=[[1,0.73],[2,0.73],[3,0.68],[4,0.61],[5,0.51],[6,0.36],[7,0.16],[8,0.10],[9,0.09]];
const beta=hp=>{ if(hp<=TAB[0][0])return TAB[0][1]; if(hp>=TAB.at(-1)[0])return TAB.at(-1)[1];
  for(let i=1;i<TAB.length;i++){const[h0,b0]=TAB[i-1],[h1,b1]=TAB[i]; if(hp<=h1)return b0+(b1-b0)*(hp-h0)/(h1-h0);} };
function localHourUtc(iso,tz,hr){ for(let off=-12;off<=14;off++){ const g=new Date(`${iso}T${String(hr).padStart(2,"0")}:00:00Z`).getTime()-off*3600e3;
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:tz,hour:"2-digit",hour12:false,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(g)).map(x=>[x.type,x.value]));
  if(parseInt(p.hour,10)%24===hr && `${p.year}-${p.month}-${p.day}`===iso) return Math.floor(g/1000); }
  return Math.floor(new Date(`${iso}T${String(hr+6).padStart(2,"0")}:00:00Z`).getTime()/1000); }
const MON={JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"};
const evToISO=ev=>{ const m=ev.match(/^(\d{2})([A-Z]{3})(\d{2})$/); return m?`20${m[1]}-${MON[m[2]]}-${m[3]}`:null; };
const bcenter=m=>{ const lo=m.floor_strike,hi=m.cap_strike; if(lo!=null&&hi!=null)return (lo+hi)/2; if(lo==null&&hi!=null)return hi-1; if(lo!=null&&hi==null)return lo+1; return null; };

// ---------- Phase A: fetch raw (cached) ----------
let raw;
if(existsSync("_edge_raw2.json")){ raw=JSON.parse(readFileSync("_edge_raw2.json","utf-8")); console.log(`loaded ${raw.length} cached event records`); }
else {
  const data=JSON.parse(readFileSync("data.json","utf-8")); raw=[];
  for(const CODE of CITIES){ const TZ=TZMAP[CODE], SERIES=SERIESMAP[CODE]; const C=data.cities[CODE]; if(!C)continue;
    const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false});
    const lp=ts=>{const p=Object.fromEntries(fmt.formatToParts(new Date(ts+"Z")).map(x=>[x.type,x.value]));return{day:`${p.year}-${p.month}-${p.day}`,hour:parseInt(p.hour,10)%24};};
    const byDay={}; const fold=(t,p,w)=>{for(let i=0;i<t.length;i++){const v=p[i];if(v==null)continue;const{day,hour}=lp(t[i]);(byDay[day]??={});const D=byDay[day];
      if(w==="o"){if(D.hiO==null||v>D.hiO)D.hiO=v;if(hour===DEC_HR)D.obsDec=v;}else{if(D.hiF==null||v>D.hiF)D.hiF=v;if(hour===DEC_HR)D.fcDec=v;}}};
    fold(C.obs.times,C.obs.temps,"o");fold(C.fc.times,C.fc.temps,"f");
    let cursor="",markets=[]; do{const j=await jget(`${K}/markets?series_ticker=${SERIES}&status=settled&limit=200${cursor?`&cursor=${cursor}`:""}`);if(!j)break;markets.push(...(j.markets||[]));cursor=j.cursor||"";}while(cursor&&markets.length<2000);
    const evMap={};for(const m of markets){(evMap[m.ticker.split("-")[1]]??=[]).push(m);}
    const events=Object.keys(evMap).map(ev=>({ev,iso:evToISO(ev)})).filter(e=>e.iso&&byDay[e.iso]?.hiO!=null&&byDay[e.iso]?.fcDec!=null).sort((a,b)=>a.iso<b.iso?1:-1).slice(0,MAXEV);
    let nEv=0;
    for(const {ev,iso} of events){ const D=byDay[iso]; if(D.obsDec==null)continue; const tgt=localHourUtc(iso,TZ,DEC_HR);
      const buckets=[];
      for(const m of evMap[ev]){ const c=bcenter(m); if(c==null||m.result==null)continue;
        const cj=await jget(`${K}/series/${SERIES}/markets/${m.ticker}/candlesticks?start_ts=${tgt-24*3600}&end_ts=${tgt+6*3600}&period_interval=60`);
        const cs=cj?.candlesticks||[]; if(!cs.length)continue;
        let best=null,bd=1e15;for(const k of cs){if(k.end_period_ts>tgt+1800)continue;const d=Math.abs(k.end_period_ts-tgt);if(d<bd){bd=d;best=k;}}
        if(!best)continue;
        buckets.push({ c, lo:m.floor_strike??null, hi:m.cap_strike??null, result:m.result,
          yesAsk:parseFloat(best.yes_ask?.close_dollars??"0"), yesBid:parseFloat(best.yes_bid?.close_dollars??"0") });
        await sleep(50);
      }
      if(buckets.length>=2){ raw.push({city:CODE,iso,fcHigh:D.hiF,obsDec:D.obsDec,fcDec:D.fcDec,actual:D.hiO,buckets}); nEv++; }
    }
    console.log(`${CODE}: ${nEv} events captured`);
  }
  writeFileSync("_edge_raw2.json",JSON.stringify(raw));
  console.log(`saved ${raw.length} event records to _edge_raw2.json`);
}

// ---------- Phase B: simulate bets ----------
function pModelBuckets(mu,sigma,buckets){ // normalized truncated-normal mass per bucket
  const raws=buckets.map(b=>{ const lo=b.lo==null?-Infinity:b.lo-0.5, hi=b.hi==null?Infinity:b.hi+0.5;
    const pHi=hi===Infinity?1:normCdf((hi-mu)/sigma), pLo=lo===-Infinity?0:normCdf((lo-mu)/sigma); return Math.max(0,pHi-pLo); });
  const s=raws.reduce((a,b)=>a+b,0); return s>0?raws.map(r=>r/s):raws.map(()=>0); }
const fee=p=>0.07*(1-p);

function simulate(sigmaMode, thr){
  let pnl=0, stake=0, nbets=0, wins=0;
  for(const e of raw){
    const hp=Math.max(0,15-DEC_HR); const mu=e.fcHigh+beta(hp)*(e.obsDec-e.fcDec);
    const sigma = sigmaMode==="fixed2.0"?2.0 : sigmaMode==="fixed2.5"?2.5 : 3.0;
    const ps=pModelBuckets(mu,sigma,e.buckets);
    for(let i=0;i<e.buckets.length;i++){ const b=e.buckets[i], p=ps[i];
      const noAsk = b.yesBid>0 ? 1-b.yesBid : null;
      const evYes = b.yesAsk>0&&b.yesAsk<1 ? p-b.yesAsk-fee(b.yesAsk) : -1;
      const evNo  = noAsk!=null&&noAsk<1 ? (1-p)-noAsk-fee(noAsk) : -1;
      let side=null,price=null,ev=null;
      if(evYes>=evNo && evYes>thr){side="yes";price=b.yesAsk;ev=evYes;}
      else if(evNo>thr){side="no";price=noAsk;ev=evNo;}
      if(!side||price<0.05||price>0.95)continue;
      const won = side==="yes" ? b.result==="yes" : b.result==="no";
      pnl += (won?1:0)-price-fee(price); stake+=price; nbets++; if(won)wins++;
    }
  }
  return {sigmaMode,thr,nbets,winPct:nbets?100*wins/nbets:0,pnl,roi:stake>0?100*pnl/stake:0,stake};
}

console.log(`\n===== GATE 2: bucket-level P&L (n_events=${raw.length}, flat 1 contract/bet, fee=7%·(1−p)) =====`);
console.log("σ-model | EV thr | #bets | win% | total P&L | ROI/stake");
for(const sm of ["fixed2.0","fixed2.5","fixed3.0"]) for(const thr of [0.05,0.10,0.15]){
  const r=simulate(sm,thr);
  console.log(`${sm.padEnd(8)}| ${thr.toFixed(2)}   | ${String(r.nbets).padStart(4)}  | ${r.winPct.toFixed(0).padStart(3)}  | $${r.pnl.toFixed(2).padStart(8)} | ${r.roi.toFixed(1).padStart(6)}%`);
}
