# CABO — Multiplayer Card Game

A real-time multiplayer card game built with **Node.js**, **Express**, and **Socket.IO**.

## Setup

```bash
cd server
npm install
npm start
```

Open `http://localhost:3000` in your browser. Share the room code with friends to play together.

## Rules

### Objective
Have the **lowest total card value** among all players.

### Card Values
| Card | Value |
|------|-------|
| King (K) | 0 |
| Ace (A) | 1 |
| 2–10 | Face value |
| Jack (J) | 11 |
| Queen (Q) | 12 |

### Setup
- Each player gets **4 cards** face-down (2 top, 2 bottom).
- You can **peek at your bottom 2 cards once** at the start. Top cards remain unknown.
- One card is flipped to start the discard pile.

### On Your Turn
1. **Draw** a card from the deck or the top of the discard pile.
2. Then choose one action:
   - **Swap** the drawn card with any of your face-down cards (old card goes to discard).
   - **Discard** the drawn card (only from deck draws) — and use its power if applicable.

### Special Powers (Deck Draws Only)
| Card | Power |
|------|-------|
| 6, 7 | Peek at one of **your own** cards |
| 8, 9 | Peek at one of an **opponent's** cards |
| 10, J | **Blind swap** any 2 cards between any players |
| Q | No power |

### Snapping
- If the top discard card matches one of **your** cards (by number), you can **snap** it at any time to discard it (even outside your turn).
- If you know an **opponent's** card matches the discard, you can snap their card and give them one of yours.
- **Wrong snap = penalty card** drawn from the deck.

### Calling CABO
- After **3 rounds**, you can call CABO on your turn (instead of drawing).
- All other players get **one final turn**.
- If you have the **strictly lowest score**: you score your card total.
- Otherwise: you get **24 penalty points**.

## Tech Stack
- **Server:** Node.js + Express + Socket.IO
- **Client:** Vanilla HTML/CSS/JS + Socket.IO client
- **Fonts:** Playfair Display + DM Sans (Google Fonts)

## Deployment
Deploy the server to any Node.js host (Heroku, Railway, Render, etc.). The client is served as static files from the `web/` directory.

## License
MIT
