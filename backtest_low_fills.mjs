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

// ────────────────────────────────────────────────────────────────────────────
// MAKER-FILL model (2026-05-26). Question: does posting a passive limit at our
// side's BID (capturing the spread) beat crossing to the ASK, once we account for
// (a) non-fill and (b) adverse selection (resting bids get hit harder on losers)?
//
// The cache has only ONE bid/ask snapshot per bucket — no intra-window price path —
// so we cannot OBSERVE fills. We instead:
//   • compute the spread-capture benefit exactly (maker pays bid, taker pays ask),
//   • model fill prob = fWin for eventual winners, k*fWin for eventual losers (k>=1),
//   • sweep k and find the break-even where maker ROI == the taker baseline ROI.
// fee() is applied to maker fills too (conservative: assumes NO Kalshi maker discount);
// a zero-fee row brackets the still-unverified maker/taker fee question.
//
// Taker baseline = select side on taker EV, fill@ask, prob 1 (the status quo).
// Maker          = select side on MAKER EV (better price clears more bets), fill@bid,
// with explicit independent fill rates fWin (winners) and fLoss (losers). Adverse
// selection = fLoss > fWin (resting bids get hit harder when the market is moving
// against us). No multiplier/cap games — both rates are passed directly in [0,1].
function makerSplit(sig, thr, fWin, fLoss, maxSpread, makerFee){
  let pnlT=0,stakeT=0,nbT=0,wT=0;
  let pnlM=0,stakeM=0,candM=0,wM=0,fills=0;
  for(const e of raw){ const mu=e.fcLow+BETA*(e.obsDec-e.fcDec); const ps=pB(mu,sig,e.buckets);
    for(let i=0;i<e.buckets.length;i++){ const b=e.buckets[i],p=ps[i];
      if(!(b.yesAsk>0&&b.yesBid>0)) continue;
      const spread=b.yesAsk-b.yesBid; if(maxSpread!=null&&spread>maxSpread) continue;
      // taker prices (cross the spread): YES@ask, NO@(1-bid)
      const yAsk=b.yesAsk, nAsk=1-b.yesBid;
      // maker prices (post at our side's bid): YES@bid, NO@(1-ask)
      const yBid=b.yesBid, nBid=1-b.yesAsk;
      // --- taker side selection (status quo) ---
      const evYt=yAsk<1?p-yAsk-fee(yAsk):-1, evNt=nAsk<1?(1-p)-nAsk-fee(nAsk):-1;
      let st=null,pt=null; if(evYt>=evNt&&evYt>thr){st="y";pt=yAsk;} else if(evNt>thr){st="n";pt=nAsk;}
      if(st&&pt>=0.05&&pt<=0.95){ const won=st==="y"?b.result==="yes":b.result==="no";
        pnlT+=(won?1:0)-pt-fee(pt); stakeT+=pt; nbT++; if(won)wT++; }
      // --- maker side selection (better entry => can clear thr more often) ---
      const evYm=yBid<1?p-yBid-makerFee(yBid):-1, evNm=nBid<1?(1-p)-nBid-makerFee(nBid):-1;
      let sm=null,pm=null; if(evYm>=evNm&&evYm>thr){sm="y";pm=yBid;} else if(evNm>thr){sm="n";pm=nBid;}
      if(sm&&pm>=0.05&&pm<=0.95){ const won=sm==="y"?b.result==="yes":b.result==="no";
        const fp=won?fWin:fLoss;                 // adverse selection: fLoss > fWin
        pnlM+=fp*((won?1:0)-pm-makerFee(pm)); stakeM+=fp*pm; candM++; if(won)wM++; fills+=fp; }
    } }
  return { taker:{nb:nbT,win:nbT?100*wT/nbT:0,pnl:pnlT,roi:stakeT>0?100*pnlT/stakeT:0},
           maker:{cand:candM,fills,winCand:candM?100*wM/candM:0,pnl:pnlM,roi:stakeM>0?100*pnlM/stakeM:0} };
}

const noFee=()=>0;
console.log("\n══ MAKER vs TAKER (σ=2.5, EV≥0.10; maker fills@bid, full taker fee unless noted) ══");
console.log("scenario                          | cand | exp.fills | win% | P&L | ROI");
const base=makerSplit(2.5,0.10,0.70,0.70,null,fee);
console.log(`TAKER (fill@ask, status quo)      | ${String(base.taker.nb).padStart(4)} | ${"—".padStart(9)} | ${base.taker.win.toFixed(0).padStart(3)}  | $${base.taker.pnl.toFixed(2).padStart(7)} | ${base.taker.roi.toFixed(1).padStart(6)}%`);
//                              label                         fWin fLoss  fee
for(const [lbl,fW,fL,mf] of [["MAKER no-AS (fW .7,fL .7), fee", .70,.70,fee],
                             ["MAKER no-AS (fW .7,fL .7), 0-fee",.70,.70,noFee],
                             ["MAKER mild  (fW .6,fL .8), fee", .60,.80,fee],
                             ["MAKER mod.  (fW .5,fL .9), fee", .50,.90,fee],
                             ["MAKER severe(fW .4,fL 1.), fee", .40,1.0,fee]]){
  const r=makerSplit(2.5,0.10,fW,fL,null,mf).maker;
  console.log(`${lbl.padEnd(34)}| ${String(r.cand).padStart(4)} | ${r.fills.toFixed(1).padStart(9)} | ${r.winCand.toFixed(0).padStart(3)}  | $${r.pnl.toFixed(2).padStart(7)} | ${r.roi.toFixed(1).padStart(6)}%`);
}
// Break-even: worst directional case (losers ALWAYS fill, fLoss=1.0); lower the winner
// fill rate until maker ROI drops to the taker baseline. fWin* = how badly winners must
// be starved before passive pricing stops beating crossing the spread.
let fStar=null; for(let fW=1.0;fW>=0.0;fW-=0.02){ const r=makerSplit(2.5,0.10,fW,1.0,null,fee).maker;
  if(r.roi<=base.taker.roi){ fStar=fW; break; } }
console.log(`\nBreak-even adverse selection (fLoss=1.0 worst case): maker ROI == taker ROI at fWin≈${fStar==null?"<0 (never)":fStar.toFixed(2)}`);
console.log(`→ even if EVERY loser fills, maker beats taker on ROI until winners fill < ${fStar==null?"~0":(fStar*100).toFixed(0)+"%"} of the time.`);
console.log("Caveats: fill@bid is the spread-capture UPPER bound (realistic = bid+1¢, between mid and bid).");
console.log("Absolute P&L scales with fill rate; the larger maker 'cand' universe is still capped by cash/Kelly live.");
