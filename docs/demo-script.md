# Demo video shot list (~90 s)

Recorded with the simulator window and the phone UI side by side. Use a fresh deck per take:

```bash
npm run dev
node node_modules/@evenrealities/evenhub-simulator/bin/index.js "http://localhost:5173/?profile=take1&timescale=60"
```

For real transcription in shot 2, set an OpenAI key or your home Whisper server in Settings first. Do not use `scripts/mock-whisper.mjs` in a video that claims live transcription.

| # | Time | Shot | Voice-over / caption |
|---|---|---|---|
| 1 | 0–8 s | Glasses home screen. | "G2 Study turns lectures into flashcards you review on your glasses." |
| 2 | 8–30 s | Long-press: REC timer starts. Speak two or three sentences of a lecture into the mic for ~70 s (cut the wait). The last transcribed sentence appears on the glasses. Long-press to stop: "Lecture saved". | "Long-press to record. Audio is transcribed in one-minute pieces; nothing is lost if the connection drops." |
| 3 | 30–45 s | Phone: Cards tab, edit one card, "Add all to deck". | "Every card is checked on the phone before it goes into the deck." |
| 4 | 45–65 s | Glasses: Review now, tap to reveal, swipe up, swipe down on one card. | "Tap to reveal, swipe up if you knew it, down if not. FSRS schedules the rest." |
| 5 | 65–85 s | Commute round: offer with the real next train, start, review two cards, then stop touching: the round ends by itself with "Arriving Zürich HB". | "On the train it sizes the round to the ride and stops before you arrive. Clock sped up 60x for the video." |
| 6 | 85–90 s | GitHub repo page. | "Tested in the simulator so far. Hardware would let me test 90-minute lectures for real." |

Captions to keep honest: "Simulator", "clock sped up 60x" during shot 5.
