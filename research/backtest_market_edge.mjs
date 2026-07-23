// Historical edge backtest: does the corrected model beat the MARKET (Kalshi)?
// For each settled event in the data.json∩Kalshi overlap window, at local-noon
// decision time, reconstruct three estimates of the daily high and compare to actual:
//   forecast  = raw GFS daily high (data.json)              [the public anchor]
//   model     = forecast + β(hrsToPeak)·(obs_noon − fc_noon) [corrected intraday model]
//   market    = prob-weighted center of Kalshi bucket prices [what we must beat]
// Then the edge regression: (actual − market) ~ (model − market). Slope>0 ⇒ our
// divergence from the price predicts the outcome ⇒ real, underpriced edge.
//
// Usage: node backtest_market_edge.mjs [maxEventsPerCity] [decisionHour]
import { readFileSync } from "node:fs";

const K = "https://api.elections.kalshi.com/trade-api/v2";
const MAXEV  = parseInt(process.argv[2] || "45", 10);
const DEC_HR = parseInt(process.argv[3] || "12", 10);  // local decision hour (12=noon)
const TZMAP = { DEN:"America/Denver", NYC:"America/New_York", LAX:"America/Los_Angeles",
  MDW:"America/Chicago", HOU:"America/Chicago", PHX:"America/Phoenix",
  SAT:"America/Chicago", DFW:"America/Chicago", AUS:"America/Chicago", SEA:"America/Los_Angeles",
  DCA:"America/New_York", BOS:"America/New_York" };
const SERIESMAP = { DEN:"KXHIGHDEN", NYC:"KXHIGHNY", LAX:"KXHIGHLAX", MDW:"KXHIGHCHI",
  HOU:"KXHIGHHOU", PHX:"KXHIGHTPHX", SAT:"KXHIGHTSATX", DFW:"KXHIGHTDAL",
  AUS:"KXHIGHAUS", SEA:"KXHIGHTSEA", DCA:"KXHIGHTDC", BOS:"KXHIGHTBOS" };
const CITIES = Object.keys(SERIESMAP);

const sleep = ms => new Promise(r => setTimeout(r, ms));
// UTC ts (sec) whose local time in tz is DEC_HR:00 on iso.
function localHourUtc(iso, tz, hr){
  for(let off=-12; off<=14; off++){ const g=new Date(`${iso}T${String(hr).padStart(2,"0")}:00:00Z`).getTime()-off*3600e3;
    const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:tz,hour:"2-digit",hour12:false,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(g)).map(x=>[x.type,x.value]));
    if(parseInt(p.hour,10)%24===hr && `${p.year}-${p.month}-${p.day}`===iso) return Math.floor(g/1000); }
  return Math.floor(new Date(`${iso}T${String(hr+6).padStart(2,"0")}:00:00Z`).getTime()/1000);
}
async function jget(u){ for(let i=0;i<3;i++){ try{ const r=await fetch(u); if(r.ok) return await r.json(); }catch(e){} await sleep(250); } return null; }

// β(hrsToPeak) — must match weather.js HIGH_BIAS_BETA.
const TAB=[[1,0.73],[2,0.73],[3,0.68],[4,0.61],[5,0.51],[6,0.36],[7,0.16],[8,0.10],[9,0.09]];
const beta=hp=>{ if(hp<=TAB[0][0])return TAB[0][1]; if(hp>=TAB.at(-1)[0])return TAB.at(-1)[1];
  for(let i=1;i<TAB.length;i++){const[h0,b0]=TAB[i-1],[h1,b1]=TAB[i]; if(hp<=h1)return b0+(b1-b0)*(hp-h0)/(h1-h0);} };

const data = JSON.parse(readFileSync("data.json","utf-8"));
const MON={JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"};
const evToISO=ev=>{ const m=ev.match(/^(\d{2})([A-Z]{3})(\d{2})$/); return m?`20${m[1]}-${MON[m[2]]}-${m[3]}`:null; };
const bucketCenter=m=>{ const lo=m.floor_strike,hi=m.cap_strike;
  if(lo!=null&&hi!=null)return (lo+hi)/2; if(lo==null&&hi!=null)return hi-1; if(lo!=null&&hi==null)return lo+1; return null; };

const all=[];               // pooled rows across cities
const perCity={};
for(const CODE of CITIES){
  const TZ=TZMAP[CODE], SERIES=SERIESMAP[CODE];
  const C=data.cities[CODE]; if(!C){ console.log(`skip ${CODE}: no data.json`); continue; }
  const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false});
  const lp=ts=>{ const p=Object.fromEntries(fmt.formatToParts(new Date(ts+"Z")).map(x=>[x.type,x.value])); return {day:`${p.year}-${p.month}-${p.day}`,hour:parseInt(p.hour,10)%24}; };
  const byDay={};
  const fold=(times,temps,w)=>{ for(let i=0;i<times.length;i++){ const v=temps[i]; if(v==null)continue; const {day,hour}=lp(times[i]);
    (byDay[day] ??= {}); const D=byDay[day];
    if(w==="o"){ if(D.hiO==null||v>D.hiO)D.hiO=v; if(hour===DEC_HR)D.obsDec=v; }
    else { if(D.hiF==null||v>D.hiF)D.hiF=v; if(hour===DEC_HR)D.fcDec=v; } } };
  fold(C.obs.times,C.obs.temps,"o"); fold(C.fc.times,C.fc.temps,"f");

  let cursor="", markets=[];
  do { const j=await jget(`${K}/markets?series_ticker=${SERIES}&status=settled&limit=200${cursor?`&cursor=${cursor}`:""}`);
    if(!j)break; markets.push(...(j.markets||[])); cursor=j.cursor||""; } while(cursor && markets.length<2000);
  const evMap={}; for(const m of markets){ const ev=m.ticker.split("-")[1]; (evMap[ev] ??= []).push(m); }
  const events=Object.keys(evMap).map(ev=>({ev,iso:evToISO(ev)})).filter(e=>e.iso && byDay[e.iso]?.hiO!=null && byDay[e.iso]?.fcDec!=null)
    .sort((a,b)=>a.iso<b.iso?1:-1).slice(0,MAXEV);

  const rows=[];
  for(const {ev,iso} of events){
    const D=byDay[iso]; if(D.obsDec==null) continue;
    const hp = Math.max(0, 15 - DEC_HR);  // hrsToPeak at decision hour
    const model = D.hiF + beta(hp)*(D.obsDec - D.fcDec);
    const tgt = localHourUtc(iso, TZ, DEC_HR);
    const startTs = tgt - 24*3600, endTs = tgt + 6*3600;
    let pts=[], sum=0;
    for(const m of evMap[ev]){ const c=bucketCenter(m); if(c==null)continue;
      const cj=await jget(`${K}/series/${SERIES}/markets/${m.ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=60`);
      const cs=cj?.candlesticks||[]; if(!cs.length)continue;
      let best=null,bd=1e15; for(const k of cs){ if(k.end_period_ts>tgt+1800)continue; const d=Math.abs(k.end_period_ts-tgt); if(d<bd){bd=d;best=k;} }
      if(!best)continue;
      const yb=parseFloat(best.yes_bid?.close_dollars??"0"), ya=parseFloat(best.yes_ask?.close_dollars??"0");
      const px=(yb>0&&ya>0)?(yb+ya)/2:parseFloat(best.price?.close_dollars??"0");
      if(px>0){ pts.push({c,px}); sum+=px; }
      await sleep(50);
    }
    if(pts.length<2||sum<=0) continue;
    const market = pts.reduce((a,x)=>a+(x.px/sum)*x.c,0);
    const row={city:CODE, iso, actual:D.hiO, fc:D.hiF, model:+model.toFixed(2), market:+market.toFixed(2)};
    rows.push(row); all.push(row);
  }
  perCity[CODE]=rows;
  console.log(`${CODE}: n=${rows.length} events`);
}

function stats(rows,f){ const e=rows.map(r=>f(r)-r.actual); const n=e.length;
  return { rmse:Math.sqrt(e.reduce((a,x)=>a+x*x,0)/n), bias:e.reduce((a,x)=>a+x,0)/n }; }
function edgeReg(rows){ const xs=rows.map(r=>r.model-r.market), ys=rows.map(r=>r.actual-r.market), n=rows.length;
  const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n; let sxy=0,sxx=0,syy=0;
  for(let i=0;i<n;i++){ sxy+=(xs[i]-mx)*(ys[i]-my); sxx+=(xs[i]-mx)**2; syy+=(ys[i]-my)**2; }
  return { slope:sxy/sxx, corr:sxy/Math.sqrt(sxx*syy), n }; }

console.log(`\n===== PER CITY (decision hour ${DEC_HR} local) =====`);
console.log("city | n  | RMSE fc | RMSE model | RMSE market | edge slope | corr");
for(const CODE of CITIES){ const r=perCity[CODE]; if(!r||r.length<5)continue;
  const f=stats(r,x=>x.fc), m=stats(r,x=>x.model), k=stats(r,x=>x.market), e=edgeReg(r);
  console.log(`${CODE.padEnd(4)} | ${String(r.length).padStart(2)} |  ${f.rmse.toFixed(2)}   |   ${m.rmse.toFixed(2)}    |    ${k.rmse.toFixed(2)}    |   ${e.slope.toFixed(2).padStart(5)}   | ${e.corr.toFixed(2)}`); }
const F=stats(all,x=>x.fc), M=stats(all,x=>x.model), K2=stats(all,x=>x.market), E=edgeReg(all);
console.log(`\n===== POOLED (n=${all.length}) =====`);
console.log(`RMSE  forecast=${F.rmse.toFixed(3)}  model=${M.rmse.toFixed(3)}  market=${K2.rmse.toFixed(3)}`);
console.log(`bias  forecast=${F.bias.toFixed(3)}  model=${M.bias.toFixed(3)}  market=${K2.bias.toFixed(3)}`);
console.log(`EDGE regression (actual-market) ~ (model-market):  slope=${E.slope.toFixed(3)}  corr=${E.corr.toFixed(3)}`);
console.log(`  model RMSE < market RMSE ⇒ we forecast the high better than the price.`);
console.log(`  slope>0 ⇒ our divergence from the price predicts the outcome = exploitable, underpriced edge.`);
