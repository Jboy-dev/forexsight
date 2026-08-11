"""Can a combination of the legitimate features predict outcome better than
the raw vote-share does? Train on the older half, test on the newer half.

Deliberately excluded: bars-to-outcome (only knowable after the trade
resolves — using it would be lookahead).
"""
import json, math, random
from collections import defaultdict

T = json.load(open('trades.json'))
for t in T: t['win'] = 1 if t['outcome'] == 'win' else 0
T.sort(key=lambda t: t['ts'])
mid = len(T)//2
TRAIN, TEST = T[:mid], T[mid:]

PAIRS = sorted({t['pair'] for t in T})

def feats(t):
    adx = t['adx'] if t['adx'] is not None else 25.0
    rsi = t['rsi'] if t['rsi'] is not None else 50.0
    f = [
        1.0,
        (t['conf']-75)/25.0,
        (adx-25)/25.0,
        (rsi-50)/25.0,
        1.0 if t['htf']=='up' else (-1.0 if t['htf']=='down' else 0.0),
        1.0 if t['struct']=='uptrend' else (-1.0 if t['struct']=='downtrend' else 0.0),
        1.0 if t['dir']=='BUY' else -1.0,
        1.0 if t['hour'] in (3,16,17) else 0.0,
        1.0 if t['hour'] < 7 else 0.0,
        math.sin(2*math.pi*t['hour']/24),
        math.cos(2*math.pi*t['hour']/24),
    ]
    f += [1.0 if t['pair']==p else 0.0 for p in PAIRS]
    return f

def train(rows, epochs=400, lr=0.08, l2=1e-3):
    d = len(feats(rows[0])); w = [0.0]*d
    idx = list(range(len(rows)))
    for ep in range(epochs):
        random.shuffle(idx)
        for i in idx:
            x = feats(rows[i]); y = rows[i]['win']
            z = sum(wi*xi for wi,xi in zip(w,x))
            p = 1/(1+math.exp(-max(-30,min(30,z))))
            g = (p-y)
            for k in range(d):
                w[k] -= lr*(g*x[k] + l2*w[k])
        lr *= 0.995
    return w

def prob(w, t):
    z = sum(wi*xi for wi,xi in zip(w, feats(t)))
    return 1/(1+math.exp(-max(-30,min(30,z))))

def brier(rows, pfn):
    return sum((pfn(t)-t['win'])**2 for t in rows)/len(rows)

def auc(rows, pfn):
    pos=[pfn(t) for t in rows if t['win']]; neg=[pfn(t) for t in rows if not t['win']]
    if not pos or not neg: return 0.5
    import bisect
    neg.sort(); tot=0
    for p in pos: tot += bisect.bisect_left(neg,p) + 0.5*(bisect.bisect_right(neg,p)-bisect.bisect_left(neg,p))
    return tot/(len(pos)*len(neg))

random.seed(7)
w = train(TRAIN)
base = sum(t['win'] for t in TRAIN)/len(TRAIN)

print("═ Held-out performance (trained on older half, tested on newer half)\n")
print(f"  {'model':<28}{'Brier':>9}{'AUC':>8}")
print(f"  {'always base rate':<28}{brier(TEST, lambda t: base):>9.4f}{0.500:>8.3f}")
print(f"  {'raw confidence /100':<28}{brier(TEST, lambda t: t['conf']/100):>9.4f}{auc(TEST, lambda t: t['conf']/100):>8.3f}")
print(f"  {'fitted model':<28}{brier(TEST, lambda t: prob(w,t)):>9.4f}{auc(TEST, lambda t: prob(w,t)):>8.3f}")

print("\n═ Does the fitted probability track reality? (test half, by decile)\n")
scored = sorted(TEST, key=lambda t: prob(w,t))
B = 10; sz = len(scored)//B
print(f"  {'decile':<9}{'n':>6}{'predicted':>12}{'actual':>10}")
for b in range(B):
    chunk = scored[b*sz:(b+1)*sz] if b<B-1 else scored[b*sz:]
    pr = sum(prob(w,t) for t in chunk)/len(chunk)
    ac = sum(t['win'] for t in chunk)/len(chunk)
    bar = '#'*int(ac*60)
    print(f"  {b+1:<9}{len(chunk):>6}{pr*100:>11.1f}%{ac*100:>9.1f}%  {bar}")

lo = scored[:sz]; hi = scored[-sz:]
print(f"\n  bottom decile actual: {sum(t['win'] for t in lo)/len(lo)*100:.1f}%")
print(f"  top decile actual:    {sum(t['win'] for t in hi)/len(hi)*100:.1f}%")
print(f"  usable spread:        {(sum(t['win'] for t in hi)/len(hi) - sum(t['win'] for t in lo)/len(lo))*100:.1f} pts")

json.dump({'w': w, 'pairs': PAIRS}, open('calib_model.json','w'))
print("\n  weights -> calib_model.json")
