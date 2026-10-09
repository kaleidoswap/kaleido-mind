# Agent evaluation and training data

Use this workflow to measure an agent today and curate data for a later training
pipeline. Collection is local and opt-in. Nothing uploads data or starts training.
Audio files and private reasoning traces are not collected.

## Try it without a model or wallet

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dataset:eval --mock
pnpm dataset:export .dataset/evaluation
```

The first command runs the production Funnel against simulated tools and saves
versioned metrics under `.dataset/evaluation`. It returns a nonzero status if any
scenario fails. Mock success validates the harness, **not model quality**. To test
a downloaded model, use `pnpm dataset:eval --model <catalog-id>`; see the CLI model
catalog. Exact model artifact hashes are not yet captured by this script (the
version is explicitly `unrecorded`); record them before comparing model releases.

Exporting this benchmark produces **zero training pairs** by design. Evaluation
records, including every record sharing their group ID, are held out. The script
writes private `train.jsonl`, `validation.jsonl` and `manifest.json` files in a new
`.dataset/exports/<id>` directory. It never overwrites an earlier export.

## Collect from an application

`@kaleidorg/mind/dataset` is portable; `@kaleidorg/mind/dataset/node` is Node-only.
React Native/browser hosts supply their own secure `appendLine` implementation.

```ts
import { DatasetCollector } from '@kaleidorg/mind/dataset';
import { LocalDatasetStore } from '@kaleidorg/mind/dataset/node';

const store = new LocalDatasetStore('.dataset/agent', 30);
const collector = new DatasetCollector({
  enabled: userSettings.shareLocalDiagnostics,
  appendLine: line => store.appendLine(line),
  // Omit sanitizeContent to collect metrics only (recommended starting point).
});

await collector.record({
  id: crypto.randomUUID(),
  groupId: sessionGroupId, // pseudonymous; same task/session variants share a group
  createdAt: new Date().toISOString(),
  source: 'production',
  modality: 'text',
  provenance: { model: modelId, modelVersion, appVersion, promptVersion },
  consent: {
    collection: userSettings.shareLocalDiagnostics,
    training: userSettings.allowTraining,
    policyVersion: '2026-10-v1',
  },
  metrics: { totalMs: elapsedMs },
  checks: [
    { name: 'confirmation_respected', pass: confirmationRespected, critical: true },
    { name: 'task_complete', pass: taskComplete, critical: false },
  ],
});
```

These identifiers, check names and model metadata must contain no personal data.
The SDK records consent decisions supplied by the host; it does not provide a
consent screen or verify that consent was obtained. Read the setting on each turn;
do not cache a collection-enabled instance across a withdrawal.

For text collection, supply `sanitizeContent` and an explicit `{ input, target }`
content pair. Your sanitizer must cover your application's names, addresses,
contacts and other sensitive content. Regex replacement or hashing alone is not
anonymization. Sanitizer or storage errors reject `record()` so the application
can surface a failed save without retrying a payment or other tool operation.

## Review before training

A log is not a correct answer. A thumbs-up or a payment approval is not a training
label. A separate curator must check the permitted text, tool correctness and
expected outcome, then supply:

```ts
review: { status: 'accepted', reviewer: 'curator-17', rubricVersion: 'wallet-v1' }
```

`exportTrainingPairs` requires collection **and** training consent, text content,
an accepted review, at least one critical check and every recorded check passing.
Rejected, unreviewed, failed or evaluation records are excluded. Duplicate record
IDs fail the export. The exporter does not decide whether a rubric is sufficient:
include your task-completion and safety requirements explicitly.

The format is a provider-neutral pair of user/assistant messages. It does not
claim compatibility with every fine-tuning API, export tool-call trajectories or
train STT/TTS models. No model judge or automatic self-labeling is used.

The stable split assigns roughly 80% of **groups** to train and 20% to validation;
small datasets need not match these percentages. Keep conversation turns,
scenario paraphrases and corrections in the same group to prevent leakage.
Maintain an independent test corpus. The export manifest keeps source IDs and
provenance for auditing; protect it like the dataset itself.

## Voice evaluation

`runVoiceAssistant` accepts an optional `onTurnMetrics` observer. It receives only
`status`, `reasonMs`, `playbackMs`, and `totalMs`; no transcript, audio or raw error.
Statuses distinguish completed turns, response errors, playback errors, empty
replies and cancellation observed after response generation. Observer failures
are isolated so they do not stop the voice loop. Hosts should catch and report
persistence errors inside their observer if loss of telemetry matters.

```ts
onTurnMetrics: async ({ status, reasonMs, playbackMs, totalMs }) => {
  // Add your consent/provenance fields using the collection pattern above.
  // metrics: { reasonMs, playbackMs, totalMs }
  // checks: [{ name: 'voice_completed', pass: status === 'completed', critical: true }]
}
```

Timing starts at a committed transcript, so it excludes speech recognition and
post-playback cooldown. Playback includes synthesis if the host's `speak()` does.
The loop does not measure first-audio latency, interruptions or transcription
accuracy. Add host measurements for these; do not report missing metrics as zero.
A voice completion check alone does not establish answer correctness.

`summarizeDataset(records)` reports per-check pass counts and per-metric sample
counts, mean, p50 and p95. Keep safety, task completion, quality and latency
separate; a faster agent must not hide failed confirmation checks. Compare cohorts
with the same model version, prompt, language, hardware and rubric; the summary
function does not automatically separate cohorts.

## Retention and deletion

`LocalDatasetStore` writes one JSON record per UUID-named `.jsonl` file using an
exclusive temporary file, file sync and rename. New directories use mode 0700 and
files 0600 where supported. The directory must be app-owned; this is not encrypted
storage or a multi-user database. Existing directory permissions are not changed.

Reads exclude records older than the configured retention (30 days by default).
Call `purgeExpired()` on startup and periodically to physically delete old records.
Call `deleteGroup(groupId)` when a user requests deletion or withdraws consent.
Previously exported files/backups require separate deletion; no distributed
revocation service is provided. The export CLI reads only the last 30 days.
Malformed records fail reads visibly. Interrupted writes may leave `.tmp` files;
these are never imported and may be removed during maintenance when no writer runs.

`.dataset/` is ignored by Git. Do not put real customer records in test fixtures,
PRs or benchmark artifacts. Diagnostic `TurnLogger` files remain a different
format: they are not automatically accepted into this training dataset. Its default
mask now omits messages/metadata, redacts free text and hashes common financial
fields, including result arguments. A custom mask replaces that policy.

## Next extensions

1. Add a review UI with correction history and a consent/deletion registry.
2. Capture model artifact hashes, tool-schema versions and device cohorts in hosts.
3. Build voice fixtures for accents, noise, numbers, interruptions and failed playback.
4. Add curated tool trajectories and preference pairs as separate versioned formats.
5. Integrate dataset quality checks into release CI and compare a frozen held-out suite.
6. Add consented audio storage only with a separate policy, retention and access model.
