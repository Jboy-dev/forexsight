"""
Faithful replay of the ForexSight signal engine over real historical bars.

Indicator maths, the vote table, and the SL/TP construction are transcribed
directly from functions/api/predict-next.js so the results describe the
engine that actually ships, not an idealised version of it.

Excluded, because they need live context that cannot be reconstructed
historically: news sentiment (15 pts), correlation basket (25 pts). Both are
directional votes, so their absence widens the confidence distribution
slightly but does not bias BUY vs SELL.
"""
import json, math, datetime as dt

def ema_series(arr, period):
    out = [None]*len(arr)
    if len(arr) < period: return out
    k = 2/(period+1)
    e = sum(arr[:period])/period
    out[period-1] = e
    for i in range(period, len(arr)):
        e = arr[i]*k + e*(1-k)
        out[i] = e
    return out

def ema(arr, p):
    s = ema_series(arr, p)
    return s[-1] if s and s[-1] is not None else None

def rsi(closes, period=14):
    if len(closes) < period+1: return None
    gains = losses = 0.0
    for i in range(1, period+1):
        d = closes[i]-closes[i-1]
        gains += max(d,0); losses += max(-d,0)
    ag, al = gains/period, losses/period
    for i in range(period+1, len(closes)):
        d = closes[i]-closes[i-1]
        ag = (ag*(period-1)+max(d,0))/period
        al = (al*(period-1)+max(-d,0))/period
    if al == 0: return 100.0
    rs = ag/al
    return 100 - 100/(1+rs)

def macd_hist(closes):
    if len(closes) < 35: return None
    e12, e26 = ema_series(closes,12), ema_series(closes,26)
    line = [a-b for a,b in zip(e12,e26) if a is not None and b is not None]
    if len(line) < 10: return None
    sig = ema(line, 9)
    return None if sig is None else line[-1]-sig

def atr(highs, lows, closes, period=14):
    if len(closes) < period+1: return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1])))
    if len(trs) < period: return None
    a = sum(trs[:period])/period
    for i in range(period, len(trs)):
        a = (a*(period-1)+trs[i])/period
    return a

def adx(highs, lows, closes, period=14):
    n = len(closes)
    if n < period*2: return None
    plus, minus, trs = [], [], []
    for i in range(1, n):
        up, dn = highs[i]-highs[i-1], lows[i-1]-lows[i]
        plus.append(up if (up > dn and up > 0) else 0)
        minus.append(dn if (dn > up and dn > 0) else 0)
        trs.append(max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1])))
    def smooth(a):
        s = sum(a[:period]); out=[s]
        for i in range(period, len(a)):
            s = s - s/period + a[i]; out.append(s)
        return out
    sp, sm, st = smooth(plus), smooth(minus), smooth(trs)
    dxs = []
    for i in range(len(st)):
        if st[i] == 0: continue
        pdi, mdi = 100*sp[i]/st[i], 100*sm[i]/st[i]
        if pdi+mdi == 0: continue
        dxs.append(100*abs(pdi-mdi)/(pdi+mdi))
    if len(dxs) < period: return None
    return sum(dxs[-period:])/period

def structure(bars):
    """HH+HL uptrend / LL+LH downtrend over last 20 bars (as in the engine)."""
    if len(bars) < 20: return 'range'
    w = bars[-20:]
    mid = len(w)//2
    h1 = max(b['h'] for b in w[:mid]); h2 = max(b['h'] for b in w[mid:])
    l1 = min(b['l'] for b in w[:mid]); l2 = min(b['l'] for b in w[mid:])
    if h2 > h1 and l2 > l1: return 'uptrend'
    if h2 < h1 and l2 < l1: return 'downtrend'
    return 'range'

def candle_pattern(b):
    body = abs(b['c']-b['o']); rng = b['h']-b['l']
    if rng <= 0: return None
    up_w = b['h']-max(b['c'],b['o']); dn_w = min(b['c'],b['o'])-b['l']
    is_bull = b['c'] > b['o']; body_pct = body/rng
    if is_bull and dn_w > body*2 and up_w < body*0.6: return 'bullish'
    if not is_bull and up_w > body*2 and dn_w < body*0.6: return 'bearish'
    if body_pct >= 0.70: return 'bullish' if is_bull else 'bearish'
    return None

def htf_trend(closes_4h):
    if len(closes_4h) < 10: return 'flat'
    chg = (closes_4h[-1]-closes_4h[0])/closes_4h[0]*100
    if chg > 0.15: return 'up'
    if chg < -0.15: return 'down'
    return 'flat'

MAX_PCT = {'XAU/USD':0.008,'BTC/USD':0.020,'ETH/USD':0.025}
def max_pct(pair):
    if pair in MAX_PCT: return MAX_PCT[pair]
    if 'JPY' in pair: return 0.005
    return 0.004

def signal_at(bars, i, pair, htf_closes):
    """Replay the engine's decision using ONLY bars[:i+1] (no lookahead)."""
    hist = bars[max(0,i-299):i+1]
    if len(hist) < 210: return None
    closes = [b['c'] for b in hist]; highs=[b['h'] for b in hist]; lows=[b['l'] for b in hist]
    px = closes[-1]
    e20, e50 = ema(closes,20), ema(closes,50)
    r  = rsi(closes,14); mh = macd_hist(closes)
    a  = atr(highs,lows,closes,14); ax = adx(highs,lows,closes,14)
    if a is None or a <= 0: return None
    st = structure(hist); cd = candle_pattern(hist[-1]); ht = htf_trend(htf_closes)

    bull = bear = 0
    if ht=='up': bull += 20
    elif ht=='down': bear += 20
    if st=='uptrend': bull += 15
    elif st=='downtrend': bear += 15
    if e20 and e50:
        if px > e20 > e50: bull += 15
        elif px < e20 < e50: bear += 15
    if r is not None:
        if 55 <= r < 70: bull += 10
        elif 30 < r <= 45: bear += 10
        elif r >= 70: bear += 15
        elif r <= 30: bull += 15
    if mh is not None:
        if mh > 0: bull += 15
        elif mh < 0: bear += 15
    if cd == 'bullish': bull += 10
    elif cd == 'bearish': bear += 10

    total = bull + bear
    if total == 0: return None
    if bull > bear: d, conf = 'BUY',  bull/total*100
    elif bear > bull: d, conf = 'SELL', bear/total*100
    else: return None

    # v424 hard MTF gate
    if d=='BUY' and ht=='down': return None
    if d=='SELL' and ht=='up':  return None

    # SL: min(1.5*ATR, structure, cap) — exactly as the engine
    atr_sl = a*1.5
    sw = hist[-min(20,len(hist)-1):]
    swing_lo = min(b['l'] for b in sw); swing_hi = max(b['h'] for b in sw)
    buf = a*0.25
    struct_sl = (px-swing_lo+buf) if d=='BUY' else (swing_hi-px+buf)
    struct_sl = max(struct_sl, a*0.5)
    cap_sl = px*max_pct(pair)
    sl_dist = min(atr_sl, struct_sl, cap_sl)
    if sl_dist <= 0: return None

    return {
        'dir': d, 'conf': conf, 'entry': px, 'sl_dist': sl_dist, 'atr': a, 'adx': ax,
        'tp1': a*2.0, 'tp2': a*4.0, 'tp3': a*7.0,
        'rsi': r, 'htf': ht, 'struct': st, 'hour': dt.datetime.utcfromtimestamp(bars[i]['t']).hour,
    }

def walk_forward(bars, i, sig, horizon=120):
    """Bar-by-bar from i+1: which level is touched first? Conservative:
    if a bar spans both SL and a TP, the SL is assumed hit first."""
    d = sig['dir']; e = sig['entry']
    sl = e - sig['sl_dist'] if d=='BUY' else e + sig['sl_dist']
    tps = [e + sig[k] if d=='BUY' else e - sig[k] for k in ('tp1','tp2','tp3')]
    best = 0
    for j in range(i+1, min(i+1+horizon, len(bars))):
        b = bars[j]
        hit_sl = (b['l'] <= sl) if d=='BUY' else (b['h'] >= sl)
        reached = 0
        for n,tp in enumerate(tps, start=1):
            if (b['h'] >= tp) if d=='BUY' else (b['l'] <= tp): reached = n
        if hit_sl and reached == 0:
            return ('loss', 0, j-i)
        if hit_sl and reached > 0:
            # same bar touched both — assume the stop filled first
            return ('loss', 0, j-i) if best == 0 else ('win', best, j-i)
        if reached > best:
            best = reached
            if best == 3: return ('win', 3, j-i)
    return ('open', best, horizon) if best == 0 else ('win', best, horizon)

def load(path):
    d = json.load(open(path))
    r = d['chart']['result'][0]; q = r['indicators']['quote'][0]
    out = []
    for k in range(len(r['timestamp'])):
        o,h,l,c = q['open'][k], q['high'][k], q['low'][k], q['close'][k]
        if None in (o,h,l,c): continue
        out.append({'t': r['timestamp'][k], 'o':o,'h':h,'l':l,'c':c})
    return out
