import json, sys, datetime as dt
from collections import defaultdict
from engine import load, signal_at, walk_forward

PAIRS = {
    'EUR/USD':'EUR_USD.json','GBP/USD':'GBP_USD.json','USD/JPY':'USD_JPY.json',
    'AUD/USD':'AUD_USD.json','USD/CAD':'USD_CAD.json','USD/CHF':'USD_CHF.json',
    'NZD/USD':'NZD_USD.json','XAU/USD':'XAU_USD.json','BTC/USD':'BTC_USD.json',
}

STEP = 6          # evaluate every 6 bars (~6h) — avoids counting one setup repeatedly
COOLDOWN = 24     # bars before the same pair may signal again

def run():
    trades = []
    for pair, f in PAIRS.items():
        bars = load(f)
        if len(bars) < 400: continue
        closes = [b['c'] for b in bars]
        last_i = -10**9
        for i in range(300, len(bars)-121, STEP):
            if i - last_i < COOLDOWN: continue
            htf = closes[max(0,i-40):i+1:4]      # crude 4H series from 1H closes
            s = signal_at(bars, i, pair, htf)
            if not s: continue
            outcome, tp_level, bars_taken = walk_forward(bars, i, s)
            if outcome == 'open': continue
            last_i = i
            rr = s['tp1']/s['sl_dist']
            trades.append({
                'pair':pair,'dir':s['dir'],'conf':round(s['conf'],1),'outcome':outcome,
                'tp':tp_level,'bars':bars_taken,'hour':s['hour'],'adx':s['adx'],
                'rsi':s['rsi'],'htf':s['htf'],'struct':s['struct'],
                'rr_tp1':rr,'rr_tp3':s['tp3']/s['sl_dist'],
                'ts':bars[i]['t'],
            })
    return trades

def pct(a,b): return (a/b*100) if b else 0.0

def report(trades):
    n=len(trades); wins=[t for t in trades if t['outcome']=='win']
    print(f"\n{'='*72}\n  BACKTEST — {n:,} trades, real hourly bars, ~2.8 years, 9 instruments\n{'='*72}")
    print(f"\n  Overall win rate (any TP before SL): {pct(len(wins),n):.1f}%  ({len(wins)}/{n})")

    # Expectancy in R using the TP actually reached
    def R(t):
        if t['outcome']!='win': return -1.0
        return {1:t['rr_tp1'],2:t['rr_tp1']*2,3:t['rr_tp3']}[t['tp']]
    tot = sum(R(t) for t in trades)
    print(f"  Expectancy: {tot/n:+.3f}R per trade   |   total {tot:+.1f}R")

    print(f"\n  {'TP reached':<14}{'count':>8}{'share':>9}")
    dist = defaultdict(int)
    for t in trades: dist[t['tp'] if t['outcome']=='win' else 0]+=1
    for k in [0,1,2,3]:
        lbl = 'SL (loss)' if k==0 else f'TP{k}'
        print(f"  {lbl:<14}{dist[k]:>8}{pct(dist[k],n):>8.1f}%")

    def bucket(name, keyfn, order=None):
        print(f"\n  {'—'*66}\n  BY {name}")
        print(f"  {'':<20}{'n':>7}{'WR':>8}{'exp R':>9}")
        g=defaultdict(list)
        for t in trades: g[keyfn(t)].append(t)
        keys = order or sorted(g.keys(), key=lambda k: -len(g[k]))
        for k in keys:
            ts=g.get(k)
            if not ts or len(ts)<25: continue
            w=[x for x in ts if x['outcome']=='win']
            e=sum(R(x) for x in ts)/len(ts)
            print(f"  {str(k):<20}{len(ts):>7}{pct(len(w),len(ts)):>7.1f}%{e:>+9.3f}")

    bucket('PAIR', lambda t:t['pair'])
    bucket('DIRECTION', lambda t:t['dir'])
    bucket('CONFIDENCE', lambda t: '90-100' if t['conf']>=90 else '80-90' if t['conf']>=80 else '70-80' if t['conf']>=70 else '60-70' if t['conf']>=60 else '<60',
           order=['90-100','80-90','70-80','60-70','<60'])
    bucket('SESSION (UTC)', lambda t: 'Asia 00-06' if t['hour']<7 else 'London 07-12' if t['hour']<13 else 'NY 13-20' if t['hour']<21 else 'Late 21-23',
           order=['Asia 00-06','London 07-12','NY 13-20','Late 21-23'])
    bucket('ADX', lambda t: 'n/a' if t['adx'] is None else '<20 (chop)' if t['adx']<20 else '20-30' if t['adx']<30 else '30+ (strong)',
           order=['<20 (chop)','20-30','30+ (strong)','n/a'])
    bucket('HTF ALIGNMENT', lambda t: f"{t['htf']}")
    bucket('STRUCTURE', lambda t: t['struct'])

    json.dump(trades, open('trades.json','w'))
    print(f"\n  (raw trades saved to trades.json)")

if __name__=='__main__':
    report(run())
