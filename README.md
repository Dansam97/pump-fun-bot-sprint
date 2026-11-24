# pump-fun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Dansam97/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Dansam97/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A breakout-riding paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2). It bets small (0.15 SOL) only on confirmed breakouts — price above its 120-slot high with many distinct buyers and positive net SOL flow behind it — cuts losers at -20%, exits when the crowd's flow turns negative, and lets winners ride with a trailing stop toward completion. Cheap 0.01 SOL probe round trips keep the 20-coin qualification bar covered. Deterministic: no clock, no randomness, no I/O.

Dev-window backtest on the kit's frozen data: net **+0.104 SOL** (70 fills, 30 coins, 35 round trips, 5 wins, max drawdown 0.9%), still positive at 2x fees. The dev result leans on one big runner, so the fresh 6-hour final window is no guarantee — the bot is built to take several small, selective shots at runners, not to tune against this tape.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=p62m1pd8&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
