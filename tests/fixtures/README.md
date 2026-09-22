# Browser fixtures

A three-state flow used by `tests/integration/browser-flow.test.ts` and by the
manual browser check in `examples/`:

```text
State A  --[Continue]-->  State B  --[Finish]-->  Success
```

The integration test drives these states through the real adapter pipeline
using the bridge's own snapshot text shape, so it needs no browser. To exercise
them against a real controlled tab, serve the directory and point the browser
capability at it:

```bash
python3 -m http.server 8099 --directory tests/fixtures
# then, in a session with /browser unlocked:
#   decision_decide { environment: "browser", objective: "Advance the flow to Success.", execute: "loop" }
```
