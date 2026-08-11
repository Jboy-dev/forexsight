# Backtest harness

Replays the shipped signal engine over real hourly bars so parameter
changes can be argued from measurement rather than intuition.

    curl "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1h&range=730d" -o EUR_USD.json
    python3 run.py      # WR / expectancy, sliced by pair, session, ADX, confidence
    python3 sweep.py    # SL/TP geometry search

`engine.py` transcribes the indicator maths, the vote table and the SL/TP
construction from `functions/api/predict-next.js`. It excludes news
sentiment and the correlation basket, which need live context that cannot
be reconstructed historically; both are directional votes, so their absence
widens the confidence spread slightly without biasing BUY vs SELL.

No lookahead: each decision uses only bars up to and including the entry
bar. When a single bar spans both the stop and a target, the stop is
assumed to fill first.

## Results — 5,971 signals, ~2.8 years, 9 instruments

    strike rate                 21.2%   (1 in 5 reaches a TP before the stop)
    expectancy                 +0.118R  per trade
    of the winners, most reach TP3, which is where the edge lives

Findings that changed the code (v436):

- The 02:00-06:00 "dead Asia" block was assumed, never measured, and was
  slightly worse than no filter (+0.114R vs +0.118R). 02:00 is one of the
  best hours (+0.319R). The hours that actually lose are 03:00, 16:00 and
  17:00 — the NY afternoon, which was never blocked.
- Expectancy falls monotonically as ADX rises (+0.190R below 20, +0.038R
  above 30). These are pullback-flavoured entries, so a strong trend means
  entering late rather than entering confirmed.
- Confidence is poorly calibrated: the 90-100 bucket wins 22.5%, the 50-60
  bucket 18.1%. A 4-point spread across a 40-point claimed range.
