"""Parameter sweep: does a different SL/TP geometry beat the shipped one?
Same signals, same entries — only the exit construction varies."""
import json
from collections import defaultdict
from engine import load, signal_at

PAIRS = {'EUR/USD':'EUR_USD.json','GBP/USD':'GBP_USD.json','USD/JPY':'USD_JPY.json',
         'AUD/USD':'AUD_USD.json','USD/CAD':'USD_CAD.json','USD/CHF':'USD_CHF.json',
         'NZD/USD':'NZD_USD.json','XAU/USD':'XAU_USD.json','BTC/USD':'BTC_USD.json'}
STEP, COOLDOWN, HORIZON = 6, 24, 120

def collect():
    """Collect entries once; exits are simulated per-config afterwards."""
    ent = []
    for pair,f in PAIRS.items():
        bars = load(f); closes=[b['c'] for b in bars]
        last=-10**9
        for i in range(300, len(bars)-HORIZON-1, STEP):
            if i-last < COOLDOWN: continue
            s = signal_at(bars,i,pair,closes[max(0,i-40):i+1:4])
            if not s: continue
            last=i
            ent.append((pair,i,s,bars))
    return ent

def simulate(ent, sl_mult, tp_mult, hours_block=(), adx_max=None, min_conf=0):
    """sl_mult/tp_mult are multiples of ATR. Single TP (all-out)."""
    n=w=0; tot=0.0
    for pair,i,s,bars in ent:
        if s['hour'] in hours_block: continue
        if adx_max is not None and s['adx'] is not None and s['adx'] > adx_max: continue
        if s['conf'] < min_conf: continue
        d,e,a = s['dir'], s['entry'], s['atr']
        sl = e-a*sl_mult if d=='BUY' else e+a*sl_mult
        tp = e+a*tp_mult if d=='BUY' else e-a*tp_mult
        rr = tp_mult/sl_mult
        res=None
        for j in range(i+1, min(i+1+HORIZON, len(bars))):
            b=bars[j]
            hit_sl = (b['l']<=sl) if d=='BUY' else (b['h']>=sl)
            hit_tp = (b['h']>=tp) if d=='BUY' else (b['l']<=tp)
            if hit_sl: res='loss'; break      # conservative: stop first on ambiguous bars
            if hit_tp: res='win';  break
        if res is None: continue
        n+=1
        if res=='win': w+=1; tot+=rr
        else: tot-=1
    return n, (w/n*100 if n else 0), (tot/n if n else 0)

if __name__=='__main__':
    ent = collect()
    print(f"  collected {len(ent):,} entries\n")

    print("═ A. SL / TP geometry (all trades)")
    print(f"  {'SL xATR':>8}{'TP xATR':>9}{'R:R':>6}{'n':>8}{'WR':>8}{'exp R':>9}")
    best=[]
    for sl in (0.75,1.0,1.5,2.0,2.5):
        for tp in (1.0,1.5,2.0,3.0,4.0,7.0):
            n,wr,e = simulate(ent, sl, tp)
            if n<400: continue
            best.append((e,sl,tp,n,wr))
            star = ' <-- shipped' if (sl,tp)==(1.5,2.0) else ''
            print(f"  {sl:>8.2f}{tp:>9.2f}{tp/sl:>6.2f}{n:>8}{wr:>7.1f}%{e:>+9.3f}{star}")
    best.sort(reverse=True)
    print(f"\n  BEST: SL {best[0][1]}xATR / TP {best[0][2]}xATR -> {best[0][4]:.1f}% WR, {best[0][0]:+.3f}R")

    e0,s0,t0 = best[0][0], best[0][1], best[0][2]
    print(f"\n═ B. Layer filters on top of SL {s0} / TP {t0}")
    print(f"  {'filter':<34}{'n':>8}{'WR':>8}{'exp R':>9}")
    n,wr,e = simulate(ent,s0,t0); print(f"  {'none (baseline)':<34}{n:>8}{wr:>7.1f}%{e:>+9.3f}")
    for lbl,kw in [
        ('block 03,16,17 UTC (worst hrs)', dict(hours_block=(3,16,17))),
        ('block 02-06 UTC (v411 rule)',    dict(hours_block=(2,3,4,5))),
        ('ADX < 20 only (chop)',           dict(adx_max=20)),
        ('ADX < 30',                       dict(adx_max=30)),
        ('conf >= 80',                     dict(min_conf=80)),
        ('conf >= 90',                     dict(min_conf=90)),
        ('conf>=80 + block worst hrs',     dict(min_conf=80, hours_block=(3,16,17))),
        ('conf>=80 + ADX<30 + worst hrs',  dict(min_conf=80, adx_max=30, hours_block=(3,16,17))),
    ]:
        n,wr,e = simulate(ent,s0,t0,**kw)
        print(f"  {lbl:<34}{n:>8}{wr:>7.1f}%{e:>+9.3f}")
