# makefun-site-generator-speed-01-v2

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/BOTTL3WAT3R/makefun-site-generator-speed-01-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/BOTTL3WAT3R/makefun-site-generator-speed-01-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0, make.fun's own static site generator. solve.js is a dependency-free ES module whose run(input) returns exactly the output tree makefun-site 1.0.0's build returns for a case's site — every page's index.html, the index and tag pages, build-report.txt and each static file — byte for byte. It is faster through compiled templates (each template becomes a JS function once per case instead of a node tree walked per page), per-case memoised slug and date formatting, allocation-free word counting, fast-path HTML escaping and a single-pass Markdown renderer. main.ts is the harness driver: it reads every case from /input/cases.json, answers each with run, and writes /output/answers.json.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=beyt0vmy&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
