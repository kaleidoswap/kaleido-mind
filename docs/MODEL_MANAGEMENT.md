# Model Management — UX spec for `rate`

A dedicated screen in the `rate` mobile app where users see, download, switch and configure their on-device models, and pair / unpair with a desktop peer for delegation.

This screen is the **runtime control surface** for KaleidoMind on mobile. Everything else (chat, voice, tool calls) is downstream of choices made here.

---

## Where it lives

`rate/screens/ModelManagementScreen.tsx`, accessible from:

1. **AI Assistant Screen** → header gear icon → "Model & Inference"
2. **Settings** → "AI & Privacy" → "Model Management"

---

## Information architecture

```
┌─────────────────────────────────────────────────────────┐
│  ← Model & Inference                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🧠 Active brain                                  │   │
│  │                                                  │   │
│  │  ● Desktop (MacBook Pro M4)        connected    │   │
│  │    Qwen3-30B-A3B  ·  24 tok/s  ·  Psy planned   │   │
│  │                                                  │   │
│  │  ○ This device (iPhone 15 Pro)                  │   │
│  │    Qwen3-4B  ·  ready  ·  12 tok/s             │   │
│  │                                                  │   │
│  │  [Switch to local]    [Always local]   [Auto]   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 📥 Local models                                  │   │
│  │                                                  │   │
│  │  ✓ Qwen3-4B-Instruct-Q4_K_M       2.4 GB  ●     │   │
│  │  ✓ Qwen3-1.7B-Instruct-Q5_K_M     1.1 GB        │   │
│  │  ↓ Qwen3-8B-Instruct-Q4_K_M     downloading 45% │   │
│  │  + Browse catalog                                │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🔗 Paired devices                                │   │
│  │                                                  │   │
│  │  💻 MacBook Pro M4               last seen now   │   │
│  │     Qwen3-30B-A3B · 24 tok/s · 24 GB             │   │
│  │     [Test] [Forget]                              │   │
│  │                                                  │   │
│  │  + Pair a new desktop                            │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ⚙️ Advanced                                       │   │
│  │                                                  │   │
│  │  Voice transcription   whisper-base.en (158 MB) >│   │
│  │  Context window        16K  >                    │   │
│  │  Thinking mode         auto  >                   │   │
│  │  Telemetry             local only  >             │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## State machine

### Active brain selection

Three modes, top-level toggle:

| Mode | Behavior |
|---|---|
| **Auto** *(default)* | `shouldDelegate()` decides per query — desktop if reachable + heavy, else local. |
| **Always local** | Never delegates, even when desktop is reachable. Privacy-max. |
| **Always desktop** | Always delegates when reachable. Falls back to local only if desktop fails. |

The selected mode persists in `store/mindSlice.ts`.

### Local model status

| Status | Indicator |
|---|---|
| Not downloaded | Plain row, "Download" button on tap |
| Downloading | Progress bar inline, can pause |
| Downloaded + cold | Filled checkmark |
| Downloaded + loaded | Filled checkmark + green dot |
| Active | Filled checkmark + green dot + highlight |
| Failed download | Red warning + "Retry" button |

Only **one** local model can be loaded at a time (RAM constraint on mobile). Switching unloads the old one — show a brief loading state.

### Paired device states

| State | Shown |
|---|---|
| Online + ready | Friendly name · model · tok/s · last-seen "now" |
| Online + busy | "thinking…" indicator |
| Online + loading model | "preparing Qwen3-30B-A3B…" |
| Offline | Last-seen "5 min ago" · greyed |
| Forgotten | Removed from list |

---

## Model catalog (browseable)

Tapping **Browse catalog** opens a list of curated models. Each has:

- Name + size on disk
- HuggingFace source link
- Tier label: **Mobile** · **Mobile-XL** · **Desktop-only**
- Estimated tok/s on the device's class (from the benchmark table)
- Function-calling score from our eval set (★★★★☆)
- Download / Cancel button

### Initial catalog (June 2026)

| Model | Size (Q4_K_M) | Tier | FC score | Use case |
|---|---|---|---|---|
| **Qwen3-1.7B-Instruct** | 1.1 GB | Mobile | ★★★☆☆ | Snappy fallback on older phones |
| **Qwen3-4B-Instruct** | 2.4 GB | Mobile | ★★★★☆ | Default on iPhone 15+/Pixel 8+ |
| **Qwen3-8B-Instruct** | 5.0 GB | Mobile-XL | ★★★★☆ | Flagship phones with ≥8 GB RAM |
| **xLAM-2-3b** | 1.9 GB | Mobile | ★★★★☆ | Pure function-call specialist |
| **Hermes-3-Llama-3.2-3B** | 2.0 GB | Mobile | ★★★★☆ | Agentic-tuned alternative |
| **Psy (size TBD)** | TBD | TBD | TBD | First-class once we confirm specs |

Desktop-only entries are shown greyed with a "Run this on your desktop instead" hint.

---

## Pair-a-desktop flow

1. Tap **Pair a new desktop**
2. Phone shows: "Looking for kaleido-agent on this network…" — scans mDNS `_kaleidomind._tcp.`
3. Found peers listed by friendly name. Tap one.
4. Mac side shows a confirmation prompt (menubar / `kaleido mind pair --listen`)
5. User approves → key exchange → "Connected ✓"
6. Phone shows the new peer in the **Paired devices** section.

**Fallback when mDNS fails:** "Scan QR / Paste pairing token" — opens camera; the desktop generates a one-shot pairing token via `kaleido mind pair --token`.

---

## Edge cases the screen must handle

| Case | UX |
|---|---|
| No local model downloaded yet | "Active brain" section shows a "Get started — download Qwen3-4B (2.4 GB)" call-to-action |
| Storage low while downloading | Cancel + show "Need X GB free, currently Y" |
| Model file corrupt / hash mismatch | Auto-delete + offer redownload, never silently use a broken model |
| Desktop loaded a different model than expected | Show the actual model name returned by `/health`, not a cached one |
| Battery below 20% while in "Always local" | Suggest switching to delegation, don't force it |
| Phone offline + Auto mode | Show "Local only — offline" pill in chat instead of "Connecting…" forever |
| Paired desktop version mismatch | Banner: "Update your desktop kaleido-agent — your phone supports newer protocol v2, desktop is v1" |

---

## Telemetry on this screen

Every action on this screen is a high-signal event for understanding usage:

- Model selected → log `{event: 'model_select', model, source: 'local|paired'}`
- Pairing succeeded → log `{event: 'pair_success', peer_id_hash}`
- Mode switched → log `{event: 'mode_change', from, to}`
- Download started / finished / failed → log with model + size + duration

All logged locally via `TurnLogger`'s side channel. Never uploaded unless the user explicitly opts in to share telemetry.

---

## Implementation order

1. **MVP (Phase 1):** active-brain section + local-model list + basic download UX. Pair-a-desktop hidden behind a dev flag.
2. **Phase 2:** pairing flow + paired-devices list + transport selection.
3. **Phase 3:** browse catalog + per-model FC scores + storage management.
4. **Phase 4 (stretch):** model side-loading from URL, model deletion, multi-pair desktops.

The screen ships **functional** in Phase 1 with one model, gains polish through Phase 3.
