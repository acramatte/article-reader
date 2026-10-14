# Experiments and decision evidence

This ledger maps decisions to their evidence; the linked references retain the raw historical results. Historical checks are not claims that the current checkout has just been tested. See [architecture](architecture.md) for the current design, [development](development.md) for repeatable commands and the [documentation index](README.md) for operations references.

## Browser inference: historical, unused

**Status / decision:** The browser-inference experiment (`main_.js`) was dead code and the only code using `innerHTML` and `URL.createObjectURL`, so it was deleted. Its unused `kokoro-js` dependency was removed earlier; revisiting the experiment requires installing that dependency separately. The last version remains in git history ([`main_.js` at `34fc9af`](https://github.com/acramatte/article-reader/blob/34fc9af9725802ab9c87e49b4cd845345d9a7c0b/main_.js)). Current inference runs behind the Node provider boundary, not in the browser.

**Evidence boundary:** The historical file demonstrated neither a supported browser engine, current packaging compatibility, nor a performance comparison with the server engines; deleting it removes only an unused trap.

## Native continuous playback: promoted to default

**Status / decision:** The [locked-screen streaming spike](streaming-spike.md#scope) was promoted to the default reader. `npm start` serves native continuous MP3 playback and reload recovery; `npm run streaming` retains the diagnostic `/streaming.html` page, with deliberate pacing, a lock-screen test mark and detailed reports. Both use the same API/provider and lifecycle engine. Current status delivery uses SSE, whereas the original experiment used recurring polling.

**Observations:** The [phone acceptance record](streaming-spike.md#phone-acceptance) documents screen-off playback on Brave/Android in the prototype, with improved buffering when test pacing was disabled. [Default-reader integration verification](streaming-spike.md#default-reader-integration-verification) records desktop recording recovery after reload and tab reopening without regeneration, plus physical Android/Brave Resume after leaving/rejoining Wi-Fi and after killing/reopening the browser. It also distinguishes real speech/media checks from synthetic UI fixtures.

**Limits:** The original phone results concern the Kokoro prototype, not qualification of Pocket TTS or SSE on Android. Integrated lock-screen controls have not been separately qualified. The early-start article test deliberately stopped generation: it does not prove full-article completion or gap-free listening. Headless checks do not establish reliable physical-phone background playback. Recordings do not survive server restart; restart recovery and cross-tab ownership are not implemented. Retain the [reload recovery](streaming-spike.md#reload-recovery) and [lifecycle limits](streaming-spike.md#limits-and-lifecycle) when interpreting these results.

## Inference engine choice and memory

**Status / decision:** Pocket TTS is the default; Kokoro remains an [opt-in CPU backend](development.md#optional-kokoro-backend) for comparison. Engine selection chooses one endpoint/catalog at startup, not simultaneous loading or automatic failover. Both images are independently built and smoke-tested. The existing observation of weaker Kokoro French speech is a limitation, not a new controlled voice-quality comparison.

**Kokoro observation:** The [sustained CPU memory-growth record](streaming-spike.md#known-inference-follow-up-sustained-cpu-memory-growth) reports an OOM kill in the dedicated local Kokoro CPU container at its unchanged 6-GiB/no-swap limit after extended testing. Restarting restored headroom and allowed acceptance to finish; it did not fix growth or establish safe long-running inference/full-length completion. This was not an observed failure of the deployed HF endpoint, whose sustained memory stability remains unverified.

**Unsuccessful mitigation experiment:** The same record preserves a partial matched-workload run with `ONEDNN_PRIMITIVE_CACHE_CAPACITY=64` and `LRU_CACHE_CAPACITY=64`. It timed out before the planned workload completed and did not establish improvement. Neither cap was promoted into the inference image; temporary comparison containers were removed. The linked upstream memory-growth report does not prove an identical cause here.

**Pocket observation:** Use the [corrected bounded Pocket benchmark and verification record](hf-inference.md#local-verification), not the withdrawn mismatched-assets results. That reference owns the workload, hardware/resource limits, throughput, cgroup memory readings, OOM counters and observed test outcomes; datasets are not duplicated here. The corrected mixed-language repeated-request run completed without OOM.

**Limits:** This bounded run does not prove absence of long-term growth, guarantee production sizing or provide a controlled speed comparison with Kokoro. Cgroup memory includes charged cache and is not process RSS. Contended runs are not usable throughput measurements. At 2× playback, the measured synthesis throughput cannot keep up indefinitely; buffering can occur until recording completion. Sustained articles must be tested on the actual hosted CPU. The recorded packaging/browser checks do not establish HF deployment, physical-phone playback or subjective voice quality; the reference preserves its timeouts, isolated rerun and unrelated mobile headline assertion rather than implying an all-green result.

## Pronunciation preparation: diagnostic protocol

**Status / method:** The [manual pronunciation regression check](development.md#manual-pronunciation-regression-check) compares real Pocket speech with independent handwritten spoken-word references, optionally including raw-text baselines. It retains WAVs, exact texts, transcripts, settings and `report.json`; baseline scores do not gate.

**Evidence boundary:** Median WER across repeated samples is triage, not phonetic proof. Sampling variability, ASR spelling and hallucinations require listening to failed/outlier clips before changing preparation rules. Digit suppression prevents number formatting from hiding misreadings, but known French date/year decoder failures need the documented per-case unsuppressed mode; unsuppressed ASR can conceal number errors. Neither decoding pass is reference-prompted. The linked protocol owns the commands, scoring rules, thresholds, exit statuses and retained-artifact requirements. It is a slow local diagnostic, not CI or evidence of general narration quality; English brand names in French voices are out of scope.

## Recording future experiments

Add a dated entry to this ledger that states the question, the decision and its status: exploratory, incomplete, rejected or promoted. Link the detailed record and retained artifacts instead of copying benchmark tables into multiple documents. Preserve failed and inconclusive runs as well as successful ones; explain corrections and identify withdrawn results explicitly.

For each record, specify the exact workload (texts/languages/voices, input lengths, request count, concurrency, speed and pacing), hardware and resource limits (CPU/quota, RAM, swap and container constraints), software/model/asset versions and image or source revisions. Describe the method: commands, warm-up, sampling, timing/memory definitions, synthetic versus real inputs, network requirements and competing workloads. Record observed outcomes separately from interpretation, including failures, timeouts, OOM state and relevant artifacts.

State caveats and untested boundaries: duration of the run, whether the full workload completed, offline versus hosted conditions, browser/physical-device coverage and what the measurements cannot establish. A comparison needs matched workloads and controlled conditions; an unmatched or contended run must not become a speed ranking. Promote a mitigation only when the target workload supports it, and update the current configuration/design references when a decision actually changes the product.
