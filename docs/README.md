# Documentation

[Article Reader overview and quick start](../README.md)

## Where to start

| You want to… | Read |
| --- | --- |
| Get the big picture without technical vocabulary | [Plain-language HTML visual guide](how-it-works.html) — open locally in a browser |
| Understand the system and its tradeoffs | [Architecture guide](architecture.md) |
| Develop locally, configure a backend, or run checks | [Development and configuration](development.md) |
| Deploy the reader on a private VPS | [Deployment runbook](deployment.md) |
| Package and host speech inference | [HF inference](hf-inference.md) |
| Find experiments, benchmarks, and device observations | [Experiment ledger](experiments.md) |
| Repeat the native-media phone/recovery experiment | [Streaming spike and acceptance evidence](streaming-spike.md) |
| Work with coding-agent session memory | [Funes tooling](funes.md) |

## How the documentation is organized

The [architecture guide](architecture.md) uses a fixed set of twelve sections, kept in one document so the system stays easy to navigate: purpose and constraints, context, strategy, building blocks, runtime flows, deployment, cross-cutting concepts, decisions, quality requirements, risks, and vocabulary. Mermaid diagrams describe the current components, development/production infrastructure, and runtime sequences.

Detailed commands and environment variables belong in the development guide; operational procedures stay in the existing deployment and inference runbooks. Historical results stay in their evidence documents and are indexed by the experiment ledger. This avoids copying setup instructions or benchmark numbers into every architecture section.

## Keeping it useful

- Feature or UI changes: update the README's current features and limits.
- Component, API, lifecycle, or infrastructure changes: update the relevant architecture section and diagrams, alongside affected configuration/runbook instructions.
- Experiments: record workload, versions, hardware/resource limits, method, results, decision, and caveats; distinguish adopted behavior from historical observations and unverified hypotheses.
- Measurements: retain a single detailed source, link it from the ledger, and explicitly withdraw superseded results rather than presenting them as comparable runs.
- Images: use a current screenshot or a clearly labeled historical demo only when it explains the reader flow; avoid screenshots of secrets, infrastructure credentials, or private article content.

The docs describe repository behavior and recorded evidence, not live deployment status. A deployment template, passed local check, or historical phone result does not establish a production rollout, capacity guarantee, or support for every browser.
