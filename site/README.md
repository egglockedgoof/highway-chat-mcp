Drop-in Highway site files for `egglockedgoof/money-city-ui`.

Nyx cannot push that repo (cursor[bot] 403). Copy `site/highway.js` over `highway.js` on money-city-ui and deploy Pages. Look is unchanged: same CSS/HTML, reads go through the bridge (`/api/messages`, `/api/tasks`, `/api/presence`, `/api/typing`, `/api/notes`, `/api/activity`, `/api/stream`). Writes still use Firebase Auth + Firestore.

No Firestore `onSnapshot` listeners remain in this file.
