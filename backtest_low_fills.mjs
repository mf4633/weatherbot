// Spread-aware fill check for the LOW edge. The +14-28% assumed taker fills at the
// candlestick ASK — but on thin 4am books the ask may be a lonely/stale quote. Here we:
//   (a) fill@ask (realistic taker, = the headline) vs fill@mid (optimistic resting-limit),
//   (b) tighten a MAX-SPREAD filter (yesAsk−yesBid): a tight spread = a real two-sided
//       market where the ask is trustworthy; wide spread = the "edge" may be un-fillable.
// If ROI holds (and #bets survives) as we require tight spreads, the edge is in liquid
// buckets and is real; if it collapses, it was a quote illusion.
import { readFileSync } from "node:fs";
const raw = JSON.parse(readFileSync("_edge_raw_low.json","utf-8"));
function normCdf(x){ const t=1/(1+0.2316419*Math.abs(x)); const d=0.3989423*Math.exp(-x*x/2);
  const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0?1-p:p; }
const LOWTAB=[[1,0.69],[2,0.67],[3,0.64],[4,0.61],[5,0.57],[6,0.52]]; const BETA=LOWTAB[1][1]; // hrsToTrough=2
const fee=p=>0.07*(1-p);
function pB(mu,sig,bk){ const r=bk.map(b=>{const lo=b.lo==null?-Infinity:b.lo-0.5,hi=b.hi==null?Infinity:b.hi+0.5;
  const pH=hi===Infinity?1:normCdf((hi-mu)/sig),pL=lo===-Infinity?0:normCdf((lo-mu)/sig);return Math.max(0,pH-pL);});
  const s=r.reduce((a,b)=>a+b,0); return s>0?r.map(x=>x/s):r.map(()=>0); }

// spread distribution of all quoted buckets
const spreads=[];
for(const e of raw) for(const b of e.buckets){ if(b.yesAsk>0&&b.yesBid>0) spreads.push(b.yesAsk-b.yesBid); }
spreads.sort((a,b)=>a-b);
const q=p=>spreads[Math.floor(p*(spreads.length-1))];
console.log(`Bucket spread (yesAsk−yesBid) distribution, n=${spreads.length}:`);
console.log(`  median=${q(0.5).toFixed(2)}  p25=${q(0.25).toFixed(2)}  p75=${q(0.75).toFixed(2)}  p90=${q(0.9).toFixed(2)}\n`);

function sim(sig,thr,fillMode,maxSpread){ let pnl=0,stake=0,nb=0,w=0;
  for(const e of raw){ const mu=e.fcLow+BETA*(e.obsDec-e.fcDec); const ps=pB(mu,sig,e.buckets);
    for(let i=0;i<e.buckets.length;i++){ const b=e.buckets[i],p=ps[i];
      if(!(b.yesAsk>0&&b.yesBid>0)) continue;
      const spread=b.yesAsk-b.yesBid; if(maxSpread!=null && spread>maxSpread) continue;
      const yesMid=(b.yesAsk+b.yesBid)/2;
      // taker price at ask, or mid for the optimistic resting-limit assumption
      const yesPrice = fillMode==="mid"?yesMid:b.yesAsk;
      const noPrice  = fillMode==="mid"?(1-yesMid):(1-b.yesBid);
      const evY=yesPrice<1?p-yesPrice-fee(yesPrice):-1;
      const evN=noPrice<1?(1-p)-noPrice-fee(noPrice):-1;
      let side=null,price=null; if(evY>=evN&&evY>thr){side="y";price=yesPrice;} else if(evN>thr){side="n";price=noPrice;}
      if(!side||price<0.05||price>0.95)continue; const won=side==="y"?b.result==="yes":b.result==="no";
      pnl+=(won?1:0)-price-fee(price); stake+=price; nb++; if(won)w++; } }
  return {nb,winPct:nb?100*w/nb:0,pnl,roi:stake>0?100*pnl/stake:0}; }

console.log("LOW edge under fill assumptions (σ=2.5, EV≥0.10):");
console.log("fill | max-spread | #bets | win% | P&L | ROI");
for(const [fill,ms] of [["ask",null],["ask",0.20],["ask",0.10],["ask",0.05],["mid",null]]){
  const r=sim(2.5,0.10,fill,ms);
  console.log(`${fill.padEnd(4)} | ${(ms==null?"any":ms.toFixed(2)).padStart(7)}   | ${String(r.nb).padStart(4)} | ${r.winPct.toFixed(0).padStart(3)} | $${r.pnl.toFixed(2).padStart(7)} | ${r.roi.toFixed(1).padStart(6)}%`);
}
console.log("\nSame, EV≥0.15 (more selective):");
console.log("fill | max-spread | #bets | win% | P&L | ROI");
for(const [fill,ms] of [["ask",null],["ask",0.10],["ask",0.05],["mid",null]]){
  const r=sim(2.5,0.15,fill,ms);
  console.log(`${fill.padEnd(4)} | ${(ms==null?"any":ms.toFixed(2)).padStart(7)}   | ${String(r.nb).padStart(4)} | ${r.winPct.toFixed(0).padStart(3)} | $${r.pnl.toFixed(2).padStart(7)} | ${r.roi.toFixed(1).padStart(6)}%`);
}
