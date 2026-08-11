"""Test each named strategy detector on its own, against the same SL/TP
ladder the app ships. Detectors transcribed from check-signals.js.

The point is to check the win rates the app asserts as fact — ICT 60%,
SMC 55%, engulfing 55%, hammer 60% and so on — against what they do on
real bars with this engine's exits.
"""
import json, math
from collections import defaultdict
from engine import load, atr, ema, rsi, adx, structure

PAIRS = {'EUR/USD':'EUR_USD.json','GBP/USD':'GBP_USD.json','USD/JPY':'USD_JPY.json',
         'AUD/USD':'AUD_USD.json','USD/CAD':'USD_CAD.json','USD/CHF':'USD_CHF.json',
         'NZD/USD':'NZD_USD.json','XAU/USD':'XAU_USD.json','BTC/USD':'BTC_USD.json'}
HORIZON, COOLDOWN = 120, 24
MAXPCT = {'XAU/USD':0.008,'BTC/USD':0.020}
def maxpct(p): return MAXPCT.get(p, 0.005 if 'JPY' in p else 0.004)

# ── detectors, transcribed from check-signals.js ──────────────────────────
def det_engulfing(o, i):
    if i < 1: return None
    c1, c2 = o[i-1], o[i]
    b1, b2 = abs(c1['c']-c1['o']), abs(c2['c']-c2['o'])
    if c2['c']>c2['o'] and c1['c']<c1['o'] and c2['o']<=c1['c'] and c2['c']>=c1['o'] and b2>b1*1.1: return 'BUY'
    if c2['c']<c2['o'] and c1['c']>c1['o'] and c2['o']>=c1['c'] and c2['c']<=c1['o'] and b2>b1*1.1: return 'SELL'
    return None

def det_sweep(o, i):
    if i < 22: return None
    win = o[i-20:i]
    hi = max(b['h'] for b in win); lo = min(b['l'] for b in win); bar = o[i]
    if bar['l'] < lo and bar['c'] > lo: return 'BUY'
    if bar['h'] > hi and bar['c'] < hi: return 'SELL'
    return None

def det_turtle(o, i):
    if i < 20: return None
    prior = o[i-20:i]
    hi = max(b['h'] for b in prior); lo = min(b['l'] for b in prior)
    if o[i]['c'] > hi: return 'BUY'
    if o[i]['c'] < lo: return 'SELL'
    return None

def det_hammer(o, i):
    b = o[i]; body = abs(b['c']-b['o']); rng = b['h']-b['l']
    if rng <= 0 or body == 0: return None
    up = b['h']-max(b['c'],b['o']); dn = min(b['c'],b['o'])-b['l']
    if dn > body*2 and up < body*0.6: return 'BUY'      # hammer
    if up > body*2 and dn < body*0.6: return 'SELL'     # shooting star
    return None

def det_orb(o, i):
    """Opening-range breakout: first hour of London (07 UTC) sets the range."""
    import datetime as dt
    h = dt.datetime.utcfromtimestamp(o[i]['t']).hour
    if h != 8 or i < 2: return None
    rng_hi, rng_lo = o[i-1]['h'], o[i-1]['l']
    if o[i]['c'] > rng_hi: return 'BUY'
    if o[i]['c'] < rng_lo: return 'SELL'
    return None

def det_vwap_revert(o, i):
    """Session VWAP reversion — fade a stretch beyond 1.5 ATR from VWAP."""
    if i < 30: return None
    win = o[i-24:i+1]
    vwap = sum((b['h']+b['l']+b['c'])/3 for b in win)/len(win)
    a = atr([b['h'] for b in win], [b['l'] for b in win], [b['c'] for b in win], 14)
    if not a: return None
    px = o[i]['c']
    if px < vwap - 1.5*a: return 'BUY'
    if px > vwap + 1.5*a: return 'SELL'
    return None

def det_ema_trend(o, i):
    if i < 60: return None
    cl = [b['c'] for b in o[max(0,i-250):i+1]]
    e20, e50 = ema(cl,20), ema(cl,50)
    if e20 is None or e50 is None: return None
    px = cl[-1]
    if px > e20 > e50: return 'BUY'
    if px < e20 < e50: return 'SELL'
    return None

def det_rsi_reversal(o, i):
    if i < 30: return None
    cl = [b['c'] for b in o[max(0,i-250):i+1]]
    r = rsi(cl,14)
    if r is None: return None
    if r <= 30: return 'BUY'
    if r >= 70: return 'SELL'
    return None

DETECTORS = {
    'ENGULFING':      det_engulfing,
    'LIQUIDITY_SWEEP':det_sweep,
    'TURTLE_BREAKOUT':det_turtle,
    'HAMMER/STAR':    det_hammer,
    'ORB (London)':   det_orb,
    'VWAP_REVERSION': det_vwap_revert,
    'EMA_TREND':      det_ema_trend,
    'RSI_REVERSAL':   det_rsi_reversal,
}

CLAIMED = {  # what _world-baselines.js asserts
    'ENGULFING':0.55,'LIQUIDITY_SWEEP':0.55,'TURTLE_BREAKOUT':0.55,'HAMMER/STAR':0.60,
    'ORB (London)':0.55,'VWAP_REVERSION':0.60,'EMA_TREND':0.55,'RSI_REVERSAL':0.58,
}

def run_detector(fn):
    trades=[]
    for pair,f in PAIRS.items():
        o = load(f)
        if len(o) < 400: continue
        last=-10**9
        for i in range(300, len(o)-HORIZON-1):
            if i-last < COOLDOWN: continue
            d = fn(o,i)
            if not d: continue
            win = o[max(0,i-250):i+1]
            a = atr([b['h'] for b in win],[b['l'] for b in win],[b['c'] for b in win],14)
            if not a or a<=0: continue
            e = o[i]['c']
            sw = o[max(0,i-20):i]
            if not sw: continue
            struct_sl = (e-min(b['l'] for b in sw)+a*0.25) if d=='BUY' else (max(b['h'] for b in sw)-e+a*0.25)
            sl_dist = min(a*1.5, max(struct_sl, a*0.5), e*maxpct(pair))
            if sl_dist<=0: continue
            last=i
            sl = e-sl_dist if d=='BUY' else e+sl_dist
            tps=[e+a*m if d=='BUY' else e-a*m for m in (2.0,4.0,7.0)]
            best=0; res=None
            for j in range(i+1, min(i+1+HORIZON, len(o))):
                b=o[j]
                hit_sl=(b['l']<=sl) if d=='BUY' else (b['h']>=sl)
                reach=0
                for n,tp in enumerate(tps,1):
                    if (b['h']>=tp) if d=='BUY' else (b['l']<=tp): reach=n
                if hit_sl and reach==0: res=('loss',0); break
                if hit_sl and reach>0:  res=('loss',0) if best==0 else ('win',best); break
                if reach>best:
                    best=reach
                    if best==3: res=('win',3); break
            if res is None:
                if best==0: continue
                res=('win',best)
            rr1 = (a*2.0)/sl_dist; rr3=(a*7.0)/sl_dist
            R = -1.0 if res[0]=='loss' else {1:rr1,2:rr1*2,3:rr3}[res[1]]
            trades.append({'pair':pair,'win':1 if res[0]=='win' else 0,'R':R,'ts':o[i]['t']})
    return trades

if __name__=='__main__':
    print(f"\n{'STRATEGY':<18}{'n':>7}{'claimed':>9}{'ACTUAL':>9}{'gap':>8}{'exp R':>9}{'verdict':>12}")
    print('-'*74)
    rows=[]
    for name,fn in DETECTORS.items():
        t = run_detector(fn)
        if len(t) < 100:
            print(f"{name:<18}{len(t):>7}      too few samples"); continue
        wr = sum(x['win'] for x in t)/len(t)
        eR = sum(x['R'] for x in t)/len(t)
        cl = CLAIMED.get(name,0)
        gap = (wr-cl)*100
        verdict = 'profitable' if eR>0.02 else ('marginal' if eR>-0.02 else 'LOSES')
        rows.append((name,len(t),cl,wr,gap,eR,verdict,t))
        print(f"{name:<18}{len(t):>7}{cl*100:>8.0f}%{wr*100:>8.1f}%{gap:>+7.1f}{eR:>+9.3f}{verdict:>12}")

    print("\n═ Out-of-sample stability (older half -> newer half, expectancy)")
    for name,n,cl,wr,gap,eR,v,t in rows:
        t.sort(key=lambda x:x['ts']); m=len(t)//2
        a=sum(x['R'] for x in t[:m])/m; b=sum(x['R'] for x in t[m:])/(len(t)-m)
        same = 'consistent' if (a>0)==(b>0) else 'FLIPS SIGN'
        print(f"  {name:<18}{a:>+8.3f} -> {b:>+8.3f}   {same}")
