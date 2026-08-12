"""MFE / MAE study — are the stop and targets in the right places?

MFE = maximum favourable excursion: the furthest a trade ever went in your
      direction before it resolved.
MAE = maximum adverse excursion: the furthest it went against you.

Targets sitting beyond typical MFE are unreachable by construction. A stop
sitting inside typical MAE gets hit by noise on trades that would have
worked. Both are measurable rather than matters of opinion.
"""
import json
from engine import load, signal_at, atr

PAIRS = {'EUR/USD':'EUR_USD.json','GBP/USD':'GBP_USD.json','USD/JPY':'USD_JPY.json',
         'AUD/USD':'AUD_USD.json','USD/CAD':'USD_CAD.json','USD/CHF':'USD_CHF.json',
         'NZD/USD':'NZD_USD.json','XAU/USD':'XAU_USD.json','BTC/USD':'BTC_USD.json'}
STEP, COOLDOWN, HORIZON = 6, 24, 120

rows=[]
for pair,f in PAIRS.items():
    bars = load(f)
    if len(bars) < 400: continue
    closes=[b['c'] for b in bars]; last=-10**9
    for i in range(300, len(bars)-HORIZON-1, STEP):
        if i-last < COOLDOWN: continue
        s = signal_at(bars,i,pair,closes[max(0,i-40):i+1:4])
        if not s: continue
        last=i
        d,e,a,sld = s['dir'], s['entry'], s['atr'], s['sl_dist']
        sl = e-sld if d=='BUY' else e+sld
        mfe=0.0; mae=0.0; resolved=None
        for j in range(i+1, min(i+1+HORIZON, len(bars))):
            b=bars[j]
            if d=='BUY':
                mfe=max(mfe, b['h']-e); mae=max(mae, e-b['l'])
                if b['l']<=sl: resolved='sl'; break
            else:
                mfe=max(mfe, e-b['l']); mae=max(mae, b['h']-e)
                if b['h']>=sl: resolved='sl'; break
        rows.append({'pair':pair,'mfe_atr':mfe/a,'mae_atr':mae/a,
                     'sl_atr':sld/a,'stopped':resolved=='sl'})

n=len(rows)
def pct(xs,p):
    xs=sorted(xs); return xs[int(len(xs)*p)] if xs else 0

mfe=[r['mfe_atr'] for r in rows]; mae=[r['mae_atr'] for r in rows]
print(f"\n  {n:,} trades\n")
print("═ How far do trades actually travel? (in ATR units)\n")
print(f"  {'':<26}{'p25':>8}{'median':>9}{'p75':>8}{'p90':>8}")
print(f"  {'MFE (best move for you)':<26}{pct(mfe,.25):>8.2f}{pct(mfe,.5):>9.2f}{pct(mfe,.75):>8.2f}{pct(mfe,.90):>8.2f}")
print(f"  {'MAE (worst against you)':<26}{pct(mae,.25):>8.2f}{pct(mae,.5):>9.2f}{pct(mae,.75):>8.2f}{pct(mae,.90):>8.2f}")

print(f"\n  Stop sits at {sum(r['sl_atr'] for r in rows)/n:.2f} ATR")
print(f"  TP1 at 2.00 ATR   TP2 at 4.00 ATR   TP3 at 7.00 ATR\n")

print("═ What share of trades ever reach each target? (MFE-based ceiling)\n")
for lbl,mult in [('TP1  2.0 ATR',2.0),('TP2  4.0 ATR',4.0),('TP3  7.0 ATR',7.0)]:
    share = sum(1 for x in mfe if x>=mult)/n*100
    print(f"  {lbl:<16}{share:>6.1f}% of trades touch this level at some point")

print("\n═ Is the stop inside the noise?\n")
slavg = sum(r['sl_atr'] for r in rows)/n
for lbl,mult in [('0.5 ATR',0.5),('1.0 ATR',1.0),('1.5 ATR (current)',1.5),('2.0 ATR',2.0),('2.5 ATR',2.5)]:
    share = sum(1 for x in mae if x>=mult)/n*100
    print(f"  stop at {lbl:<20} would be hit on {share:>5.1f}% of trades")

print("\n═ The trades that got stopped — how far had they gone in your favour first?\n")
stopped=[r for r in rows if r['stopped']]
good = [r['mfe_atr'] for r in stopped]
print(f"  of {len(stopped):,} stopped trades:")
for thr in (0.5,1.0,2.0):
    c=sum(1 for g in good if g>=thr)
    print(f"    {c/len(stopped)*100:5.1f}% had first run {thr}+ ATR in profit before reversing")
