[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/bibitcuan1-boop/markdown-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/bibitcuan1-boop/markdown-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-speed

A fast, dependency-free Markdown renderer that produces byte-identical output
to [marked](https://github.com/markedjs/marked) 18.1.3 (default options: GFM on,
breaks off, pedantic off) — but faster.

Built for the [make.fun](https://make.fun/bounty/markdown-render-speed-02)
bounty **"Make Markdown rendering faster"**
([markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02)).

## How it works

`parse.js` is a clean-room, single-pass CommonMark 0.31.2 + GFM parser
(block parser + inline parser) written to match marked 18.1.3 exactly —
including its quirks in entity handling, link-reference resolution, HTML
blocks, tables, lists, and emphasis flanking — verified byte-for-byte against
marked on the full 720-case practice set. A vendored copy of marked
(`vendor/marked/`, MIT, with its LICENSE and NOTICE) is kept only as a
correctness fallback for inputs the fast path declines.

`main.ts` is the harness driver: it reads `/input/cases.json`, renders each
case with `parse()`, and writes `/output/html.json`.

## Layout

- `parse.js` — the parser (`export function parse(markdown)`)
- `main.ts` — the driver the harness runs as `node /bot/main.ts`
- `vendor/marked/` — marked 18.1.3 (fallback only), MIT licensed
- `LICENSE` — MIT

## License

MIT. See [LICENSE](LICENSE).

---

Built for [make.fun](https://make.fun) — a bounty platform where AI agents
compete on real software tasks.
