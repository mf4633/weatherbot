// Variable-limit (liquidity-scaled maker) validation, HIGH + LOW, 2026-05-26.
// Rule we will ship: QUALIFY a bet exactly as live does (net-of-fee EV at the ASK >= gate),
// then place the buy at a VARIABLE limit price instead of crossing to the ask:
//   spread = ask - bid (our side)
//   captureFrac = clamp(REF_SPREAD / spread, 0, 1)   // tight book -> 1 (post at bid); wide -> small
//   limitPx = ask - spread*captureFrac               // = bid when frac=1, -> ask as spread widens
//   healthCap = priceForEV(p, EV_FLOOR)              // never pay so much EV drops below floor
//   limitPx = clamp(min(limitPx, healthCap), bid, ask)
// Because qualification is at the ask (EV>=gate) and the limit is <= ask, realized EV only
// improves; healthCap (floor<=gate) never binds. Fills modeled with winner/loser rates to
// show the spread-capture-vs-adverse-selection band. fill@bid is the spread-capture UPPER bound.
import { readFileSync } from "node:fs";
function normCdf(x){ const t=1/(1+0.2316419*Math.abs(x)); const d=0.3989423*Math.exp(-x*x/2);
  const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0?1-p:p; }
const fee=p=>0.07*(1-p);
const HIGHTAB=[[1,0.73],[2,0.73],[3,0.68],[4,0.61],[5,0.51],[6,0.36],[7,0.16],[8,0.10],[9,0.09]];
const LOWTAB =[[1,0.69],[2,0.67],[3,0.64],[4,0.61],[5,0.57],[6,0.52]];
const REF_SPREAD=0.05;            // spread at/below which we post at the bid (full capture)
const EV_FLOOR=0.10;              // healthy net-EV floor for the limit price (<= gate, won't bind)
function priceForEV(p,ev){ return (p - 0.07 - ev)/0.93; }   // invert EV=p-0.07-0.93L
function pB(mu,sig,bk){ const r=bk.map(b=>{const lo=b.lo==null?-Infinity:b.lo-0.5,hi=b.hi==null?Infinity:b.hi+0.5;
  const pH=hi===Infinity?1:normCdf((hi-mu)/sig),pL=lo===-Infinity?0:normCdf((lo-mu)/sig);return Math.max(0,pH-pL);});
  const s=r.reduce((a,b)=>a+b,0); return s>0?r.map(x=>x/s):r.map(()=>0); }

function variableLimit(ask,bid,p){
  const spread=ask-bid; if(spread<=0) return ask;
  const frac=Math.min(1,Math.max(0,REF_SPREAD/spread));
  let px=ask-spread*frac;                       // liquidity-scaled
  px=Math.min(px, priceForEV(p,EV_FLOOR));      // health cap (won't bind under EV-gate)
  return Math.min(ask, Math.max(bid, px));
}

function run(raw,fcKey,beta,sig,gate,fWin,fLoss){
  let tPnl=0,tStake=0,tN=0,tW=0;        // taker (fill@ask, prob 1)
  let vPnl=0,vStake=0,vN=0,vW=0,vFill=0,capSum=0; // variable limit (fill@limitPx, fill-prob)
  for(const e of raw){ const mu=e[fcKey]+beta*(e.obsDec-e.fcDec); const ps=pB(mu,sig,e.buckets);
    for(let i=0;i<e.buckets.length;i++){ const b=e.buckets[i],p=ps[i];
      if(!(b.yesAsk>0&&b.yesBid>0)) continue;
      // our-side ask/bid for YES and NO
      const yAsk=b.yesAsk, yBid=b.yesBid, nAsk=1-b.yesBid, nBid=1-b.yesAsk;
      // QUALIFY at the ask (matches live gate): pick the side with higher taker EV >= gate
      const evY=p-yAsk-fee(yAsk), evN=(1-p)-nAsk-fee(nAsk);
      let side=null,ask=null,bid=null,pw=null;
      if(evY>=evN&&evY>gate){side="y";ask=yAsk;bid=yBid;pw=p;}
      else if(evN>gate){side="n";ask=nAsk;bid=nBid;pw=1-p;}
      if(!side||ask<0.05||ask>0.95) continue;
      const won=side==="y"?b.result==="yes":b.result==="no";
      // taker
      tPnl+=(won?1:0)-ask-fee(ask); tStake+=ask; tN++; if(won)tW++;
      // variable limit
      const Lpx=variableLimit(ask,bid,pw); capSum+=(ask-Lpx);
      const fp=won?fWin:fLoss;
      vPnl+=fp*((won?1:0)-Lpx-fee(Lpx)); vStake+=fp*Lpx; vN++; if(won)vW++; vFill+=fp;
    } }
  return { taker:{n:tN,win:tN?100*tW/tN:0,pnl:tPnl,roi:tStake>0?100*tPnl/tStake:0},
           vlim:{n:vN,fills:vFill,win:vN?100*vW/vN:0,pnl:vPnl,roi:vStake>0?100*vPnl/vStake:0,
                 avgCap:vN?100*capSum/vN:0} };
}

const high=JSON.parse(readFileSync("_edge_raw2.json","utf-8"));
const low =JSON.parse(readFileSync("_edge_raw_low.json","utf-8"));
function show(lbl,raw,fcKey,tab,sig,gate){
  const beta=tab[1][1]; // hrsToExtreme=2
  console.log(`\n── ${lbl} (σ=${sig}, EV-gate@ask=${gate}, β=${beta}) ──`);
  console.log("scenario                  | bets | exp.fills | avgCapture | win% | P&L | ROI");
  const noAS=run(raw,fcKey,beta,sig,gate,0.70,0.70);
  console.log(`TAKER (fill@ask)          | ${String(noAS.taker.n).padStart(4)} | ${"—".padStart(9)} | ${"—".padStart(10)} | ${noAS.taker.win.toFixed(0).padStart(3)}  | $${noAS.taker.pnl.toFixed(2).padStart(7)} | ${noAS.taker.roi.toFixed(1).padStart(6)}%`);
  for(const [l,fW,fL] of [["VLIM no-AS (.7/.7)",.70,.70],["VLIM mod-AS (.5/.9)",.50,.90],["VLIM severe (.4/1.)",.40,1.0]]){
    const r=run(raw,fcKey,beta,sig,gate,fW,fL).vlim;
    console.log(`${l.padEnd(26)}| ${String(r.n).padStart(4)} | ${r.fills.toFixed(1).padStart(9)} | ${(r.avgCap.toFixed(1)+"¢").padStart(10)} | ${r.win.toFixed(0).padStart(3)}  | $${r.pnl.toFixed(2).padStart(7)} | ${r.roi.toFixed(1).padStart(6)}%`);
  }
}
console.log("VARIABLE-LIMIT vs TAKER — qualify@ask, fill@variable-limit (liquidity-scaled toward bid)");
for(const g of [0.10,0.15,0.25]){
  show(`HIGH  EV≥${g}`,high,"fcHigh",HIGHTAB,2.5,g);
  show(`LOW   EV≥${g}`,low ,"fcLow", LOWTAB ,2.5,g);
}
